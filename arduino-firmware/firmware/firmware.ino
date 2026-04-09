#include <Wire.h>
#include <Servo.h>

// ---------------- PINS ----------------
#define SERVO_A_PIN 3
#define SERVO_B_PIN 2
#define BUTTON_PIN 4

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

// ---------------- PID ----------------
float Kp = 0.08;
float Ki = 0.0005;
float Kd = 0.2;

float integral = 0;
float lastError = 0;

// ---------------- SERVO ----------------
int servoA_stop = 90;

// Max speed limits (safety clamp)
int maxSpeedOffset = 25;  // limits how far from 90 we go

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);
  Wire.begin();

  servoA.attach(SERVO_A_PIN);
  servoB.attach(SERVO_B_PIN);

  pinMode(BUTTON_PIN, INPUT_PULLUP);

  delay(1000);

  Serial.println("Starting homing...");
  homeServoA();
}

// ---------------- LOOP ----------------
void loop() {
  updateEncoder();
  handleSerial();
  controlServoA_PID();
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
  if (abs(error) < 15) {
    servoA.write(servoA_stop);
    integral = 0;
    return;
  }

  // --- PID math ---
  integral += error;
  float derivative = error - lastError;

  float output = (Kp * error) + (Ki * integral) + (Kd * derivative);

  lastError = error;

  // Clamp output to safe speed
  if (output > maxSpeedOffset) output = maxSpeedOffset;
  if (output < -maxSpeedOffset) output = -maxSpeedOffset;

  int servoCommand = servoA_stop + output;

  servoCommand = constrain(servoCommand, 60, 120);

  servoA.write(servoCommand);

  // Debug
  Serial.print("Err: ");
  Serial.print(error);
  Serial.print(" Out: ");
  Serial.print(output);
  Serial.print(" Cmd: ");
  Serial.println(servoCommand);
}

// ---------------- HOMING (UNCHANGED) ----------------
void homeServoA() {
  Serial.println("Homing start...");

  servoA.write(110);

  while (digitalRead(BUTTON_PIN) == HIGH) {
    updateEncoder();
    delay(10);
  }

  servoA.write(90);
  delay(100);

  servoA.write(70);
  while (digitalRead(BUTTON_PIN) == LOW) {
    updateEncoder();
    delay(10);
  }

  minPos = totalAngle;

  servoA.write(90);
  delay(100);

  servoA.write(70);
  while (digitalRead(BUTTON_PIN) == HIGH) {
    updateEncoder();
    delay(10);
  }

  servoA.write(90);
  delay(100);

  servoA.write(110);
  while (digitalRead(BUTTON_PIN) == LOW) {
    updateEncoder();
    delay(10);
  }

  maxPos = totalAngle;

  servoA.write(90);

  homed = true;

  // Move Servo B to 50%
  int angleB = map(50, 0, 100, 18, 126);
  servoB.write(angleB);

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
    servoB.write(angle);
  }
}