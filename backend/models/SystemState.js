import mongoose from 'mongoose';

const systemStateSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      default: 'esp32_main',
      unique: true
    },
    lastStatus: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    commands: {
      webModeOverride: { type: Number, default: -1 },
      forceChargingActive: { type: Boolean, default: false },
      inverter: { type: Boolean, default: false },
      smps: { type: Boolean, default: false },
      lastHeartbeat: { type: Number, default: 0 },
      otaUrl: { type: String, default: '' }
    },
    deviceOnline: {
      type: Boolean,
      default: false
    },
    lastSeen: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: true
  }
);

export const SystemState = mongoose.model('SystemState', systemStateSchema);
