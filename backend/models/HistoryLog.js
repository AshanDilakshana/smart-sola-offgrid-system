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
    }
  },
  {
    timestamps: true
  }
);

export const HistoryLog = mongoose.model('HistoryLog', historyLogSchema);
