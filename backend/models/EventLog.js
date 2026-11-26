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
    }
  },
  {
    timestamps: true
  }
);

export const EventLog = mongoose.model('EventLog', eventLogSchema);
