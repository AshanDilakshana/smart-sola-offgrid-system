import mongoose from 'mongoose';

const historyLogSchema = new mongoose.Schema(
  {
    epoch: {
      type: Number,
      required: true,
      index: true,
      unique: true
    },
    time: {
      type: String,
      default: ''
    },
    batteryVoltage: {
      type: Number,
      required: true
    },
    batteryCurrent: {
      type: Number,
      default: 0
    },
    batterySoc: {
      type: Number,
      default: 0
    },
    cellVoltages: {
      type: [Number],
      default: [0, 0, 0, 0]
    },
    solarVoltage: {
      type: Number,
      default: 0
    },
    gridPresent: {
      type: Boolean,
      default: false
    },
    inverterState: {
      type: Boolean,
      default: false
    },
    smpsState: {
      type: Boolean,
      default: false
    },
    mode: {
      type: String,
      default: 'POWER OFF'
    },
    syncedFromOfflineBuffer: {
      type: Boolean,
      default: false
    },
    phase: {
      type: String,
      enum: ['charging', 'discharging', 'idle'],
      default: 'idle'
    },
    source: {
      type: String,
      enum: ['esp32', 'offline-buffer', 'sample-seed'],
      default: 'esp32',
      index: true
    },
    recordedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

historyLogSchema.index({ recordedAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

export const HistoryLog = mongoose.model('HistoryLog', historyLogSchema);
