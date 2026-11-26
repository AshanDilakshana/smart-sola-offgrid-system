#ifndef JK_BMS_H
#define JK_BMS_H

#include <Arduino.h>

class JKBMS {
public:
    float voltage = 0.0;
    float current = 0.0;
    int soc = 0;
    float cellVoltages[4] = {0.0, 0.0, 0.0, 0.0};
    int cellCount = 4;
    bool dataValid = false;
    unsigned long lastUpdateTime = 0;
    static const unsigned long BMS_TIMEOUT_MS = 10000;

    void checkTimeout() {
        if (dataValid && (millis() - lastUpdateTime > BMS_TIMEOUT_MS)) {
            dataValid = false;
            voltage = 0.0;
            current = 0.0;
        }
    }

    void begin(HardwareSerial &serial, int rxPin, int txPin) {
        serial.begin(115200, SERIAL_8N1, rxPin, txPin);
    }

    void requestData(HardwareSerial &serial) {
        // "Read All Data" command frame for JK BMS
        uint8_t request[] = {0x4E, 0x57, 0x00, 0x13, 0x00, 0x00, 0x00, 0x00, 0x06, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x68, 0x00, 0x00, 0x01, 0x29};
        serial.write(request, sizeof(request));
    }

    bool readData(HardwareSerial &serial) {
        bool updated = false;
        
        int bytesReadThisLoop = 0;
        while (serial.available() && bytesReadThisLoop < 100) {
            uint8_t c = serial.read();
            buffer[bufferIndex++] = c;
            bytesReadThisLoop++;
            
            if (bufferIndex >= sizeof(buffer)) {
                bufferIndex = 0; 
            }
        }

        // Check if we have a full frame starting with 0x4E 0x57
        for (int i = 0; i < bufferIndex - 11; i++) {
            if (buffer[i] == 0x4E && buffer[i+1] == 0x57) {
                int length = (buffer[i+2] << 8) | buffer[i+3];
                
                // Prevent fake headers
                if (length > 400) {
                    continue; 
                }
                
                // If the entire frame has been received
                if (i + length + 4 <= bufferIndex) {
                    if (parseFrame(&buffer[i], length + 4)) {
                        updated = true;
                    }
                    // Shift the remaining data in buffer
                    int remaining = bufferIndex - (i + length + 4);
                    if (remaining > 0) {
                        memmove(buffer, &buffer[i + length + 4], remaining);
                        bufferIndex = remaining;
                    } else {
                        bufferIndex = 0;
                    }
                    return updated;
                } else {
                    // Frame is incomplete. Shift it to the start of the buffer 
                    // so we don't overflow while waiting for the rest of the bytes
                    if (i > 0) {
                        int remaining = bufferIndex - i;
                        memmove(buffer, &buffer[i], remaining);
                        bufferIndex = remaining;
                    }
                    checkTimeout();
                    return updated;
                }
            }
        }
        checkTimeout();
        return updated;
    }

private:
    uint8_t buffer[512];
    int bufferIndex = 0;

    bool parseFrame(uint8_t* frame, int totalLength) {
        // Offset 10 is record type, 0x02 or 0x01 is all data
        if (frame[10] != 0x02 && frame[10] != 0x01) {
            return false;
        }
        
        int pos = 11;
        
        // 1. Parse Cell Info Block (0x79)
        if (frame[pos] == 0x79) {
            int blockLength = frame[pos + 1];
            int cellsInBlock = blockLength / 3;
            for (int c = 0; c < cellsInBlock && c < 4; c++) {
                int cellNum = frame[pos + 2 + (c * 3)];
                uint16_t cellMv = (frame[pos + 2 + (c * 3) + 1] << 8) | frame[pos + 2 + (c * 3) + 2];
                if (cellNum >= 1 && cellNum <= 4) {
                    cellVoltages[cellNum - 1] = cellMv * 0.001;
                }
            }
            pos += 2 + blockLength;
        } else {
            return false; 
        }

        // 2. Scan forward for 0x83 (Voltage), 0x84 (Current), 0x85 (SOC)
        int maxScan = pos + 40; 
        while (pos < totalLength - 4 && pos < maxScan) {
            uint8_t type = frame[pos];
            
            if (type == 0x80 || type == 0x81 || type == 0x82) {
                pos += 3;
            } 
            else if (type == 0x83) {
                uint16_t volRaw = (frame[pos+1] << 8) | frame[pos+2];
                voltage = volRaw * 0.01;
                pos += 3;
            }
            else if (type == 0x84) {
                uint16_t curRaw = (frame[pos+1] << 8) | frame[pos+2];
                if (curRaw & 0x8000) {
                    current = -((curRaw & 0x7FFF) * 0.01); // Discharging (Negative Amps)
                } else {
                    current = (curRaw & 0x7FFF) * 0.01;  // Charging (Positive Amps)
                }
                pos += 3;
            }
            else if (type == 0x85) {
                soc = frame[pos+1]; // Battery SOC %
                pos += 2;
            }
            else {
                pos++;
            }
        }
        
        if (voltage > 5.0) {
            dataValid = true;
            lastUpdateTime = millis();
            return true;
        }
        
        return false;
    }
};

#endif
