import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import User from "../models/User.js";
import Officer from "../models/Officer.js";
import verifyToken from "../middlewares/verifyToken.js";

const router = express.Router();

/* ── helpers ── */
const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });

/* ── Device ID sanitisation ── */
function sanitizeDeviceId(raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^[a-zA-Z0-9\-_:]{8,128}$/.test(t)) return null;
  return t;
}

/* ── Age validator ── */
function validateDob(dob) {
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return "Invalid date of birth.";
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  if (age < 10) return "You must be at least 10 years old to register.";
  if (age > 120) return "Invalid date of birth.";
  return null;
}

/* ── Rate limiters ── */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  handler: (req, res) => res.status(429).json({ error: "Too many login attempts. Please try again after 15 minutes." }),
  standardHeaders: true,
  legacyHeaders: false,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  handler: (req, res) => res.status(429).json({ error: "Too many accounts created from this device. Please try again after an hour." }),
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) => res.status(429).json({ error: "Too many admin login attempts. Please try again after 15 minutes." }),
  standardHeaders: true,
  legacyHeaders: false,
});

/* ── STATUS ── */
router.get("/", (req, res) => {
  res.json({ message: "✅ Auth routes working" });
});

/* ── GET CURRENT USER / OFFICER PROFILE ── */
router.get("/me", verifyToken, async (req, res) => {
  try {
    const officer = await Officer.findById(req.user.userId);
    if (officer) {
      return res.json({
        _id: officer._id,
        id: officer._id,
        username: officer.username,
        name: officer.name,
        badgeNumber: officer.badgeNumber,
        mobile: officer.mobile || "",
        department: officer.department,
        station: officer.station,
        role: officer.role,
      });
    }

    const user = await User.findById(req.user.userId);
    if (user) {
      return res.json({
        _id: user._id,
        id: user._id,
        username: user.username,
        mobile: user.mobile,
        gender: user.gender,
        dob: user.dob,
        age: user.age,
        role: "user",
      });
    }

    res.status(404).json({ error: "User not found" });
  } catch (err) {
    console.error("[Auth /me Error]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── OFFICER REGISTRATION / GENERAL REGISTER ── */
router.post("/register", signupLimiter, async (req, res) => {
  try {
    const { mobile, password, name, badgeNumber, department, station, role, username } = req.body;
    const primaryMobile = (mobile || username)?.trim();

    if (!primaryMobile || !password) {
      return res.status(400).json({ error: "Mobile number and password required" });
    }

    const cleanMobile = primaryMobile.trim();
    const existingOfficer = await Officer.findOne({
      $or: [{ mobile: cleanMobile }, { username: cleanMobile }]
    });

    if (existingOfficer) {
      return res.status(400).json({ error: "Officer mobile number already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const officer = await Officer.create({
      mobile: cleanMobile,
      username: cleanMobile,
      password: hashedPassword,
      name: name?.trim() || cleanMobile,
      badgeNumber: badgeNumber?.trim() || `PB-${Math.floor(1000 + Math.random() * 9000)}`,
      department: department?.trim() || "Night Patrol",
      station: station?.trim() || "Main Station",
      role: role || "officer",
    });

    const rawDeviceId = req.headers["x-device-id"] || req.body?.deviceId;
    const cleanDeviceId = sanitizeDeviceId(rawDeviceId);
    const tokenPayload = {
      userId: officer._id,
      role: officer.role,
      username: officer.mobile,
      mobile: officer.mobile,
      name: officer.name,
      badgeNumber: officer.badgeNumber,
    };
    if (cleanDeviceId) tokenPayload.deviceId = cleanDeviceId;
    const token = signToken(tokenPayload);

    res.status(201).json({
      message: "Officer registered successfully",
      token,
      user: {
        _id: officer._id,
        id: officer._id,
        username: officer.mobile,
        mobile: officer.mobile,
        name: officer.name,
        badgeNumber: officer.badgeNumber,
        department: officer.department,
        station: officer.station,
        role: officer.role,
      },
    });
  } catch (err) {
    console.error("[Auth Register Error]", err);
    res.status(500).json({ error: "Internal server error registering officer" });
  }
});

/* ── SIGNUP (MOBILE USER) ── */
router.post("/signup", signupLimiter, async (req, res) => {
  try {
    const { username, password, mobile, trustedContacts, deviceId, gender, dob } = req.body;

    if (!username || !password || !mobile) {
      return res.status(400).json({ error: "Username, password, mobile required" });
    }
    if (typeof username !== "string" || username.trim().length < 3 || username.trim().length > 50) {
      return res.status(400).json({ error: "Username must be 3–50 characters" });
    }
    if (!/^[0-9]{10}$/.test(mobile)) {
      return res.status(400).json({ error: "Mobile must be exactly 10 digits" });
    }
    if (typeof password !== "string" || password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: "Password must be 6–128 characters" });
    }
    if (gender && !["male", "female", "other"].includes(gender)) {
      return res.status(400).json({ error: "Gender must be male, female, or other." });
    }
    if (dob) {
      const dobError = validateDob(dob);
      if (dobError) return res.status(400).json({ error: dobError });
    }

    const existing = await User.findOne({ mobile });
    if (existing) return res.status(400).json({ error: "Mobile already registered" });

    const hashedPassword = await bcrypt.hash(password, 12);
    const userData = {
      username: username.trim(),
      password: hashedPassword,
      mobile: mobile.trim(),
      trustedContacts: trustedContacts || [],
    };
    if (gender) userData.gender = gender;
    if (dob) userData.dob = new Date(dob);

    const user = await User.create(userData);
    const cleanDeviceId = sanitizeDeviceId(deviceId);
    const tokenPayload = { userId: user._id, role: "user", username: user.username };
    if (cleanDeviceId) tokenPayload.deviceId = cleanDeviceId;
    const token = signToken(tokenPayload);

    res.status(201).json({
      message: "Signup successful",
      token,
      user: {
        _id: user._id,
        id: user._id,
        username: user.username,
        mobile: user.mobile,
        gender: user.gender,
        dob: user.dob,
        age: user.age,
        trustedContacts: user.trustedContacts,
        role: "user",
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── LOGIN (OFFICER & USER FLEXIBLE) ── */
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { mobile, username, password, deviceId } = req.body;
    const identifier = (mobile || username)?.trim();

    if (!password || typeof password !== "string") {
      return res.status(400).json({ error: "Password is required" });
    }
    if (!identifier) {
      return res.status(400).json({ error: "Mobile number or username required" });
    }

    // 1. Try Officer login first by mobile, username, or badgeNumber
    const officer = await Officer.findOne({
      $or: [{ mobile: identifier }, { username: identifier }, { badgeNumber: identifier }]
    });

    if (officer) {
      const isMatch = await bcrypt.compare(password, officer.password);
      if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

      const rawDeviceId = req.headers["x-device-id"] || deviceId;
      const cleanDeviceId = sanitizeDeviceId(rawDeviceId);
      const tokenPayload = {
        userId: officer._id,
        role: officer.role,
        username: officer.mobile || officer.username,
        mobile: officer.mobile || officer.username,
        name: officer.name,
        badgeNumber: officer.badgeNumber,
      };
      if (cleanDeviceId) tokenPayload.deviceId = cleanDeviceId;
      const token = signToken(tokenPayload);

      return res.json({
        message: "Officer login successful",
        token,
        user: {
          _id: officer._id,
          id: officer._id,
          username: officer.mobile || officer.username,
          mobile: officer.mobile || officer.username,
          name: officer.name,
          badgeNumber: officer.badgeNumber,
          department: officer.department,
          station: officer.station,
          role: officer.role,
        },
      });
    }

    // 2. Try User login by mobile or username
    let user = await User.findOne({
      $or: [{ mobile: identifier }, { username: identifier }]
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const cleanDeviceId = sanitizeDeviceId(deviceId);
    const tokenPayload = { userId: user._id, role: "user", username: user.username };
    if (cleanDeviceId) tokenPayload.deviceId = cleanDeviceId;
    const token = signToken(tokenPayload);

    res.json({
      message: "Login successful",
      token,
      user: {
        _id: user._id,
        id: user._id,
        username: user.username,
        mobile: user.mobile,
        gender: user.gender,
        dob: user.dob,
        age: user.age,
        role: "user",
      },
    });
  } catch (err) {
    console.error("[Login Error]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── ADMIN LOGIN ── */
router.post("/admin/login", adminLoginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (!adminUser || !adminPass) return res.status(500).json({ error: "Admin credentials not configured" });
    if (username !== adminUser || password !== adminPass) return res.status(401).json({ error: "Invalid admin credentials" });

    const token = signToken({ role: "admin", username });
    res.json({ message: "Admin login successful", token });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── GET all users (admin only) ── */
router.get("/users", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access only" });
    const users = await User.find({}, "-password -refreshTokens");
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── UPDATE profile ── */
router.put("/update/:id", verifyToken, async (req, res) => {
  try {
    if (req.user.role === "user" && req.user.userId.toString() !== req.params.id) {
      return res.status(403).json({ error: "Cannot update another user's profile" });
    }
    const { username, mobile, trustedContacts, gender, dob } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    if (username !== undefined) user.username = username;
    if (mobile !== undefined) user.mobile = mobile;
    if (trustedContacts !== undefined) user.trustedContacts = trustedContacts;
    if (gender !== undefined) {
      if (!["male", "female", "other"].includes(gender)) {
        return res.status(400).json({ error: "Gender must be male, female, or other." });
      }
      user.gender = gender;
    }
    if (dob !== undefined) {
      const dobError = validateDob(dob);
      if (dobError) return res.status(400).json({ error: dobError });
      user.dob = new Date(dob);
    }
    await user.save();
    res.json({
      message: "Profile updated",
      username: user.username,
      mobile: user.mobile,
      gender: user.gender,
      dob: user.dob,
      age: user.age,
      trustedContacts: user.trustedContacts,
    });
  } catch (err) {
    console.error("[Profile Update Error]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ── UPDATE OFFICER PROFILE ── */
router.put("/officer/update", verifyToken, async (req, res) => {
  try {
    const officer = await Officer.findById(req.user.userId);
    if (!officer) return res.status(404).json({ error: "Officer not found" });

    const { name, badgeNumber, mobile, department, station } = req.body;
    if (name !== undefined && name.trim()) officer.name = name.trim();
    if (badgeNumber !== undefined && badgeNumber.trim()) officer.badgeNumber = badgeNumber.trim();
    if (mobile !== undefined) officer.mobile = mobile.trim();
    if (department !== undefined) officer.department = department.trim();
    if (station !== undefined) officer.station = station.trim();

    await officer.save();

    res.json({
      message: "Officer profile updated successfully",
      user: {
        _id: officer._id,
        id: officer._id,
        username: officer.username,
        name: officer.name,
        badgeNumber: officer.badgeNumber,
        mobile: officer.mobile || "",
        department: officer.department,
        station: officer.station,
        role: officer.role,
      },
    });
  } catch (err) {
    console.error("[Officer Profile Update Error]", err);
    res.status(500).json({ error: "Internal server error updating officer profile" });
  }
});

export default router;