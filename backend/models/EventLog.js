import mongoose from 'mongoose';

const eventLogSchema = new mongoose.Schema(
  {
    epoch: {
      type: Number,
      default: () => Math.floor(Date.now() / 1000),
      index: true
    },
    type: {
      type: String,
      enum: ['info', 'action', 'warning', 'danger', 'success'],
      default: 'info'
    },
    event: {
      type: String,
      required: true
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    source: {
      type: String,
      enum: ['system', 'ui', 'esp32', 'sample-seed'],
      default: 'system'
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

eventLogSchema.index({ recordedAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

export const EventLog = mongoose.model('EventLog', eventLogSchema);
