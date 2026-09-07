
import mongoose from "mongoose";

const panicSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
  },
  username: {        
    type: String,
    required: false,
  },
  location: {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
});

// TTL index: documents auto-delete after 7 days
panicSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const Panic = mongoose.model("Panic", panicSchema);
export default Panic;


