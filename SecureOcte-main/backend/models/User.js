import mongoose from "mongoose";

const RefreshTokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true },
  deviceId:  { type: String },
  issuedAt:  { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  revoked:   { type: Boolean, default: false },
});

const UserSchema = new mongoose.Schema({
  username:        { type: String, required: true },
  password:        { type: String, required: true },
  mobile:          { type: String, required: true, unique: true },
  trustedContacts: [{ type: String }],
  // Optional fields — not required so existing users without them still work
  gender: { type: String, enum: ["male", "female", "other"] },
  dob:    { type: Date },
  refreshTokens: [RefreshTokenSchema],
});

/* Virtual: age computed from dob */
UserSchema.virtual("age").get(function () {
  if (!this.dob) return null;
  const today = new Date();
  const birth = new Date(this.dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
});

UserSchema.set("toJSON",   { virtuals: true });
UserSchema.set("toObject", { virtuals: true });

const User = mongoose.model("User", UserSchema);
export default User;
