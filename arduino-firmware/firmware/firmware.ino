#include <Wire.h>
#include <Servo.h>

// ---------------- PINS ----------------
#define SERVO_A_PIN 3
#define SERVO_B_PIN 2
// AS5600 analog OUT (magnet at machine north / front) — homing uses this, not the limit switch.
#define MAGNET_ANALOG_PIN A2

// 1 = print A2 (analog) forever only; normal firmware disabled (wins over spin test if both set)
#define MAGNET_A2_SERIAL_DEBUG 0
// 1 = print A2 + spin servo A CW forever; normal firmware disabled
#define MAGNET_SERVO_SPIN_TEST 0

// ---------------- OBJECTS ----------------
Servo servoA;
Servo servoB;

// ---------------- AS5600 ----------------
#define AS5600_ADDR 0x36

uint16_t lastRawAngle = 0;
long totalAngle = 0;

// ---------------- LIMITS ----------------
long minPos = 0;
long maxPos = 0;
bool homed = false;

// ---------------- TARGET ----------------
long targetA = 0;
// Last PWM written to B; -1 = never (skip compare). Used to filter tiny command jitter.
int servoB_lastWritten = -1;

// Position deadband (encoder ticks): hold stop if |target − actual| below this (was 15; doubled for jitter)
const int SERVO_A_DEADBAND_TICKS = 30;
// Ignore servo B writes when angle change is smaller than this (PWM units); doubled from prior ~4
const int SERVO_B_ANGLE_DEADBAND = 8;

// ---------------- PID ----------------
float Kp = 0.08;
float Ki = 0.0005;
float Kd = 0.2;

float integral = 0;
float lastError = 0;

// ---------------- SERVO A (speed vs travel limits) ----------------
int servoA_stop = 90;
// Mid-travel: max |deg offset from center| (fast). At min/max encoder: ramps down to NEAR_LIMIT.
const int SERVO_A_OFFSET_FAST = 58;
const int SERVO_A_OFFSET_NEAR_LIMIT = 14;
// Within this many ticks of minPos or maxPos (per side), blend down toward NEAR_LIMIT
const long SERVO_A_APPROACH_TICKS_MAX = 500;
// Absolute pulse clamp (widen = faster; tighten if servo/mechanics stall)
const int SERVO_A_PULSE_MIN = 20;
const int SERVO_A_PULSE_MAX = 160;

// Homing / calibration only — original moderate speed (PID uses SERVO_A_OFFSET_* above)
const int CAL_SPIN_CW = 110;
const int CAL_SPIN_CCW = 70;

// A2 homing: count as north only when analog is above this (rejects 1–10 noise)
const int MAGNET_HOME_MIN = 10;
// Debounce: consecutive samples above MAGNET_HOME_MIN → at north
const int HOME_STREAK_ON = 5;
// Started on magnet: probe CW 1s; magnet “center” on A2 is above this — if crossed, CCW 2s then homing
const int MAGNET_CENTER_THRESHOLD = 500;
const unsigned long HOME_ON_MAGNET_PROBE_CW_MS = 1000UL;
const unsigned long HOME_ON_MAGNET_REVERSE_CCW_MS = 2000UL;
// After first north (CW approach): run CCW this long to clear before 2nd north pass
const unsigned long HOME_CLEAR_CCW_MS = 2000UL;

const unsigned long CALIB_TIMEOUT_MS = 120000UL;

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);
  Wire.begin();

  servoA.attach(SERVO_A_PIN);
  servoB.attach(SERVO_B_PIN);

#if MAGNET_A2_SERIAL_DEBUG
  Serial.println(F("DEBUG: A2 analog only (forever) — set MAGNET_A2_SERIAL_DEBUG 0 for normal"));
#elif MAGNET_SERVO_SPIN_TEST
  Serial.println(F("TEST: magnet A2 (analog) + servo A CW forever — set MAGNET_SERVO_SPIN_TEST 0 for normal"));
  servoA.write(CAL_SPIN_CW);
#else
  delay(1000);

  Serial.println("Starting homing...");
  homeServoA();
#endif
}

// ---------------- LOOP ----------------
void loop() {
#if MAGNET_A2_SERIAL_DEBUG
  Serial.println(analogRead(MAGNET_ANALOG_PIN));
  delay(50);
#elif MAGNET_SERVO_SPIN_TEST
  Serial.println(analogRead(MAGNET_ANALOG_PIN));
  servoA.write(CAL_SPIN_CW);
  delay(50);
#else
  updateEncoder();
  handleSerial();
  controlServoA_PID();
#endif
}

// ---------------- AS5600 ----------------
uint16_t readRawAngle() {
  Wire.beginTransmission(AS5600_ADDR);
  Wire.write(0x0C);
  Wire.endTransmission();
  Wire.requestFrom(AS5600_ADDR, 2);

  uint16_t angle = Wire.read() << 8 | Wire.read();
  return angle & 0x0FFF;
}

// ---------------- MULTI-TURN ----------------
void updateEncoder() {
  uint16_t current = readRawAngle();
  int diff = current - lastRawAngle;

  if (diff > 2048) diff -= 4096;
  if (diff < -2048) diff += 4096;

  totalAngle += diff;
  lastRawAngle = current;
}

// ---------------- PID CONTROL ----------------
void controlServoA_PID() {
  if (!homed) return;

  float error = targetA - totalAngle;

  // Deadband (prevents jitter)
  if (abs(error) < SERVO_A_DEADBAND_TICKS) {
    servoA.write(servoA_stop);
    integral = 0;
    return;
  }

  // --- PID math ---
  integral += error;
  float derivative = error - lastError;

  float output = (Kp * error) + (Ki * integral) + (Kd * derivative);

  lastError = error;

  // Near calibrated ends of travel, cap PID drive (fast mid-span, slow at limits)
  long span = maxPos - minPos;
  long dLo = totalAngle - minPos;
  long dHi = maxPos - totalAngle;
  float blend = 1.f;
  if (span > 0) {
    long approach = max(50L, min(SERVO_A_APPROACH_TICKS_MAX, span / 3));
    if (dLo < 0 || dHi < 0) blend = 0.f;
    else {
      float r0 = (float)dLo / (float)approach;
      float r1 = (float)dHi / (float)approach;
      if (r0 > 1.f) r0 = 1.f;
      if (r1 > 1.f) r1 = 1.f;
      blend = (r0 < r1) ? r0 : r1;
    }
  }
  int maxOff =
      SERVO_A_OFFSET_NEAR_LIMIT +
      (int)((float)(SERVO_A_OFFSET_FAST - SERVO_A_OFFSET_NEAR_LIMIT) * blend + 0.5f);

  if (output > maxOff) output = maxOff;
  if (output < -maxOff) output = -maxOff;

  int servoCommand = servoA_stop + (int)output;

  servoCommand = constrain(servoCommand, SERVO_A_PULSE_MIN, SERVO_A_PULSE_MAX);

  servoA.write(servoCommand);
}

// ---------------- MAGNET (ANALOG A2) ----------------
inline bool magnetHomingHit() {
  return analogRead(MAGNET_ANALOG_PIN) > MAGNET_HOME_MIN;
}

bool homingTimedOut(unsigned long t0) {
  if (millis() - t0 < CALIB_TIMEOUT_MS) return false;
  Serial.println("Homing ABORT: timeout");
  servoA.write(servoA_stop);
  homed = false;
  return true;
}

// Spin CCW for fixed time; false if homing timed out
bool homingRunCcwForMs(unsigned long ms, unsigned long t0) {
  servoA.write(CAL_SPIN_CCW);
  unsigned long tStart = millis();
  while (millis() - tStart < ms) {
    if (homingTimedOut(t0)) return false;
    updateEncoder();
    delay(4);
  }
  return true;
}

// CW for ms while sampling A2; *passedCenter = true if any sample > MAGNET_CENTER_THRESHOLD; *a2Max = peak seen
bool homingRunCwProbeForCenter(unsigned long ms, unsigned long t0, bool *passedCenter, int *a2Max) {
  if (passedCenter) *passedCenter = false;
  int maxA = 0;
  servoA.write(CAL_SPIN_CW);
  unsigned long tStart = millis();
  while (millis() - tStart < ms) {
    if (homingTimedOut(t0)) return false;
    int a = analogRead(MAGNET_ANALOG_PIN);
    if (a > maxA) maxA = a;
    if (passedCenter && a > MAGNET_CENTER_THRESHOLD) *passedCenter = true;
    updateEncoder();
    delay(4);
  }
  if (a2Max) *a2Max = maxA;
  return true;
}

// ---------------- HOMING (magnet on A2, AS5600 = travel) ----------------
void homeServoA() {
  Serial.println("Homing start (magnet A2 + AS5600)...");

  lastRawAngle = readRawAngle();
  totalAngle = 0;

  Serial.print("A2 raw (still): ");
  Serial.println(analogRead(MAGNET_ANALOG_PIN));

  unsigned long t0 = millis();

  // Started on magnet: CW 1s probe (see if A2 crosses center >500); if yes, CCW 2s; then same homing as off-magnet
  {
    int on = 0;
    bool bootOnNorth = false;
    for (int i = 0; i < 40; i++) {
      if (magnetHomingHit()) {
        if (++on >= HOME_STREAK_ON) {
          bootOnNorth = true;
          break;
        }
      } else {
        on = 0;
      }
      delay(3);
    }
    if (bootOnNorth) {
      Serial.println(F("Start on north (already on magnet)."));
      bool passedCenter = false;
      int a2MaxProbe = 0;
      Serial.println(F("Probe: servo A CW 1s (A2 > 500 = passed through center)..."));
      if (!homingRunCwProbeForCenter(HOME_ON_MAGNET_PROBE_CW_MS, t0, &passedCenter, &a2MaxProbe)) return;
      Serial.print(F("A2 max during CW probe: "));
      Serial.print(a2MaxProbe);
      Serial.print(F(" (threshold "));
      Serial.print(MAGNET_CENTER_THRESHOLD);
      Serial.println(F(")"));
      if (passedCenter) {
        Serial.println(F("Passed >500: reversing servo A CCW 2s, then normal homing..."));
        if (!homingRunCcwForMs(HOME_ON_MAGNET_REVERSE_CCW_MS, t0)) return;
      } else {
        Serial.println(F("Did not pass >500: continuing homing."));
      }
      servoA.write(servoA_stop);
      delay(80);
      updateEncoder();
    }
  }

  // --- 1) Clockwise until north (debounced analog > MAGNET_HOME_MIN) ---
  Serial.println("Phase: CW to north...");
  int streak = 0;
  servoA.write(CAL_SPIN_CW);
  while (streak < HOME_STREAK_ON) {
    if (homingTimedOut(t0)) return;
    updateEncoder();
    if (magnetHomingHit()) streak++;
    else streak = 0;
    delay(4);
  }

  servoA.write(servoA_stop);
  delay(80);
  updateEncoder();
  long encAtFirstNorth = totalAngle;
  Serial.print("North (CW) totalAngle: ");
  Serial.println(encAtFirstNorth);

  // --- Leave north: fixed CCW time to clear magnet ---
  Serial.println("Phase: CCW clear north (2s)...");
  if (!homingRunCcwForMs(HOME_CLEAR_CCW_MS, t0)) return;
  servoA.write(servoA_stop);
  delay(80);
  updateEncoder();

  // --- 2) Counter-clockwise until north again (360 span) ---
  Serial.println("Phase: CCW to north (2nd hit)...");
  streak = 0;
  servoA.write(CAL_SPIN_CCW);
  while (streak < HOME_STREAK_ON) {
    if (homingTimedOut(t0)) return;
    updateEncoder();
    if (magnetHomingHit()) streak++;
    else streak = 0;
    delay(4);
  }

  servoA.write(servoA_stop);
  delay(80);
  updateEncoder();
  long encAtSecondNorth = totalAngle;
  Serial.print("North (CCW) totalAngle: ");
  Serial.println(encAtSecondNorth);

  long spanTicks = labs(encAtFirstNorth - encAtSecondNorth);
  if (spanTicks < 50) {
    Serial.println("Homing WARN: span very small; check magnet analog / directions");
  }

  minPos = 0;
  maxPos = spanTicks;
  // North (second pass) = zero for commands
  totalAngle = 0;
  lastRawAngle = readRawAngle();

  homed = true;

  int angleB = map(50, 0, 100, 18, 126);
  servoB.write(angleB);
  servoB_lastWritten = angleB;

  Serial.print("360 deg span (ticks): ");
  Serial.println(maxPos);
  Serial.print("Servo B set to 50% (angle: ");
  Serial.print(angleB);
  Serial.println(")");

  Serial.println("Homing complete");
}

// ---------------- SERIAL ----------------
void handleSerial() {
  if (!Serial.available()) return;

  String cmd = Serial.readStringUntil('\n');
  cmd.trim();

  if (cmd.startsWith("servoA")) {
    int percent = cmd.substring(6).toInt();
    percent = constrain(percent, 0, 100);

    targetA = map(percent, 0, 100, minPos, maxPos);

    Serial.print("TargetA: ");
    Serial.println(targetA);
  }

  if (cmd.startsWith("servoB")) {
    int percent = cmd.substring(6).toInt();
    percent = constrain(percent, 0, 100);

    int angle = map(percent, 0, 90, 18, 104);
    if (servoB_lastWritten < 0 ||
        abs(angle - servoB_lastWritten) >= SERVO_B_ANGLE_DEADBAND) {
      servoB.write(angle);
      servoB_lastWritten = angle;
    }
  }
}