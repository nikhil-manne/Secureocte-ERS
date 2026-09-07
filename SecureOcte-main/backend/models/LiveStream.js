/**
 * models/LiveStream.js
 * Added expiresAt field (TTL index defined in dbIndexes.js).
 * Stream viewer GET checks this field and returns 410 if expired.
 */
import mongoose from "mongoose";

const liveStreamSchema = new mongoose.Schema({
  streamId:  { type: String, required: true, unique: true },
  userId:    { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: {
    type:    Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 h
    index:   true,
  },
});

const LiveStream = mongoose.model("LiveStream", liveStreamSchema);
export default LiveStream;
