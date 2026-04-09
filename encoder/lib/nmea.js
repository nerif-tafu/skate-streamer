function nmeaCoord(raw, hemi) {
  if (raw === undefined || raw === "") return null;
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  const deg = Math.floor(v / 100);
  const min = v - deg * 100;
  let dec = deg + min / 60;
  if (hemi === "S" || hemi === "W") dec = -dec;
  return dec;
}

export function parseNmea(line) {
  line = String(line).trim();
  const star = line.indexOf("*");
  if (star >= 0) line = line.slice(0, star);
  if (!line.startsWith("$")) return null;

  const parts = line.slice(1).split(",");
  const sid = parts[0] ?? "";
  const patch = {};

  if (sid.endsWith("RMC") && parts.length >= 10) {
    const status = parts[2];
    if (status !== "A") {
      patch.fix = 0;
      return patch;
    }
    const lat = nmeaCoord(parts[3], parts[4]);
    const lon = nmeaCoord(parts[5], parts[6]);
    if (lat == null || lon == null) return null;
    patch.lat = lat;
    patch.lon = lon;
    patch.fix = 1;
    const knots = Number.parseFloat(parts[7]);
    if (Number.isFinite(knots)) patch.speedKmh = knots * 1.852;
    const course = Number.parseFloat(parts[8]);
    if (Number.isFinite(course)) patch.course = course;
    patch.time = parts[1] || null;
    patch.date = parts[9] || null;
    return patch;
  }

  if (sid.endsWith("GGA") && parts.length >= 10) {
    const quality = Number.parseInt(parts[6], 10);
    const lat = nmeaCoord(parts[2], parts[3]);
    const lon = nmeaCoord(parts[4], parts[5]);
    if (lat != null && lon != null && Number.isFinite(quality) && quality > 0) {
      patch.lat = lat;
      patch.lon = lon;
      patch.fix = quality;
    }
    const sats = Number.parseInt(parts[7], 10);
    if (Number.isFinite(sats)) patch.satellites = sats;
    const hdop = Number.parseFloat(parts[8]);
    if (Number.isFinite(hdop) && hdop > 0) patch.hdop = hdop;
    const alt = Number.parseFloat(parts[9]);
    if (Number.isFinite(alt)) patch.alt = alt;
    return Object.keys(patch).length ? patch : null;
  }

  // Geographic position. Some modules output this instead of RMC.
  if (sid.endsWith("GLL") && parts.length >= 7) {
    const lat = nmeaCoord(parts[1], parts[2]);
    const lon = nmeaCoord(parts[3], parts[4]);
    const status = parts[6]; // A=valid, V=void
    if (status !== "A") {
      patch.fix = 0;
      return patch;
    }
    if (lat == null || lon == null) return null;
    patch.lat = lat;
    patch.lon = lon;
    patch.fix = 1;
    patch.time = parts[5] || null;
    return patch;
  }

  // GNSS DOP and active satellites. Useful when GGA is sparse.
  if (sid.endsWith("GSA") && parts.length >= 17) {
    const fixType = Number.parseInt(parts[2], 10); // 1=no fix, 2=2D, 3=3D
    if (Number.isFinite(fixType)) patch.fix = fixType <= 1 ? 0 : fixType;
    const hdop = Number.parseFloat(parts[16]);
    if (Number.isFinite(hdop) && hdop > 0) patch.hdop = hdop;
    return Object.keys(patch).length ? patch : null;
  }

  return null;
}
