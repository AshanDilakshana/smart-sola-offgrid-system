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
        // Enlarge UART RX FIFO buffer to 1024 bytes so ~308-byte JK BMS frames never overflow during OLED/I2C transfers
        serial.setRxBufferSize(1024);
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
        while (serial.available() && bytesReadThisLoop < 360) {
            uint8_t c = serial.read();
            if (bufferIndex < (int)sizeof(buffer)) {
                buffer[bufferIndex++] = c;
            } else {
                // Buffer full without valid frame: discard oldest half to prevent lockup
                memmove(buffer, &buffer[256], 256);
                bufferIndex = 256;
                buffer[bufferIndex++] = c;
            }
            bytesReadThisLoop++;
        }

        // Check if we have a full frame starting with 0x4E 0x57
        for (int i = 0; i <= bufferIndex - 12; i++) {
            if (buffer[i] == 0x4E && buffer[i+1] == 0x57) {
                int length = ((int)buffer[i+2] << 8) | (int)buffer[i+3];
                
                // Prevent fake/corrupted headers (valid JK BMS data frames have length between 20 and 400 bytes)
                if (length < 20 || length > 400) {
                    continue; 
                }
                
                int frameTotalLen = length + 4;
                // If the entire frame has been received
                if (i + frameTotalLen <= bufferIndex) {
                    if (parseFrame(&buffer[i], frameTotalLen)) {
                        updated = true;
                    }
                    // Shift the remaining data in buffer
                    int remaining = bufferIndex - (i + frameTotalLen);
                    if (remaining > 0 && remaining < (int)sizeof(buffer)) {
                        memmove(buffer, &buffer[i + frameTotalLen], remaining);
                        bufferIndex = remaining;
                    } else {
                        bufferIndex = 0;
                    }
                    checkTimeout();
                    return updated;
                } else {
                    // Frame is incomplete. Shift it to the start of the buffer 
                    // so we don't overflow while waiting for the rest of the bytes
                    if (i > 0) {
                        int remaining = bufferIndex - i;
                        if (remaining > 0 && remaining < (int)sizeof(buffer)) {
                            memmove(buffer, &buffer[i], remaining);
                            bufferIndex = remaining;
                        } else {
                            bufferIndex = 0;
                        }
                    }
                    checkTimeout();
                    return updated;
                }
            }
        }

        // If buffer accumulated noise without any 0x4E 0x57 header, keep only the last byte (in case it is 0x4E)
        if (bufferIndex > 64) {
            uint8_t lastByte = buffer[bufferIndex - 1];
            if (lastByte == 0x4E) {
                buffer[0] = 0x4E;
                bufferIndex = 1;
            } else {
                bufferIndex = 0;
            }
        }

        checkTimeout();
        return updated;
    }

private:
    uint8_t buffer[512];
    int bufferIndex = 0;

    bool parseFrame(uint8_t* frame, int totalLength) {
        if (totalLength < 20 || totalLength > 404) {
            return false;
        }

        // Offset 10 is record type, 0x02 or 0x01 is all data
        if (frame[10] != 0x02 && frame[10] != 0x01) {
            return false;
        }
        
        int pos = 11;
        
        // 1. Parse Cell Info Block (0x79) with strict bounds checking
        if (pos + 2 <= totalLength && frame[pos] == 0x79) {
            int blockLength = frame[pos + 1];
            if (blockLength < 3 || pos + 2 + blockLength > totalLength - 4) {
                return false;
            }
            int cellsInBlock = blockLength / 3;
            for (int c = 0; c < cellsInBlock && c < 4; c++) {
                int cellOffset = pos + 2 + (c * 3);
                if (cellOffset + 2 >= totalLength) break;
                int cellNum = frame[cellOffset];
                uint16_t cellMv = ((uint16_t)frame[cellOffset + 1] << 8) | (uint16_t)frame[cellOffset + 2];
                if (cellNum >= 1 && cellNum <= 4) {
                    cellVoltages[cellNum - 1] = cellMv * 0.001f;
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
            else if (type == 0x83 && pos + 2 < totalLength) {
                uint16_t volRaw = ((uint16_t)frame[pos+1] << 8) | (uint16_t)frame[pos+2];
                voltage = volRaw * 0.01f;
                pos += 3;
            }
            else if (type == 0x84 && pos + 2 < totalLength) {
                uint16_t curRaw = ((uint16_t)frame[pos+1] << 8) | (uint16_t)frame[pos+2];
                if (curRaw & 0x8000) {
                    current = -((curRaw & 0x7FFF) * 0.01f); // Discharging (Negative Amps)
                } else {
                    current = (curRaw & 0x7FFF) * 0.01f;  // Charging (Positive Amps)
                }
                pos += 3;
            }
            else if (type == 0x85 && pos + 1 < totalLength) {
                soc = frame[pos+1]; // Battery SOC %
                pos += 2;
            }
            else {
                pos++;
            }
        }
        
        if (voltage > 5.0f && voltage < 30.0f) {
            dataValid = true;
            lastUpdateTime = millis();
            return true;
        }
        
        return false;
    }
};

#endif
