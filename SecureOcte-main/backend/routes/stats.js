import adminAuth from "../middlewares/adminAuth.js";
import express from "express";
import CabEscortTrip from "../models/CabEscortTrip.js";
import WalkSession from "../models/WalkSession.js";

const router = express.Router();

router.get("/dashboard", adminAuth, async (req, res) => {
  try {
    const now = new Date();

    // ── Calendar boundaries (midnight local time) ──────────────────────────
    const startOfDay       = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfDay);
    startOfYesterday.setDate(startOfDay.getDate() - 1);

    // Calendar month boundaries
    const startOfMonth     = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(startOfMonth);   // exclusive upper bound

    // Calendar week boundaries (Monday-start), clipped to the current month so
    // the week bucket does not exceed month-to-date in analytics.
    const dayOfWeek = startOfDay.getDay(); // 0=Sun, 1=Mon, ...
    const mondayOffset = (dayOfWeek + 6) % 7;
    const startOfCalendarWeek = new Date(startOfDay);
    startOfCalendarWeek.setDate(startOfDay.getDate() - mondayOffset);

    const startOfWeek = new Date(
      Math.max(startOfCalendarWeek.getTime(), startOfMonth.getTime())
    );
    const startOfLastWeek = new Date(startOfCalendarWeek);
    startOfLastWeek.setDate(startOfCalendarWeek.getDate() - 7);
    const endOfLastWeek = new Date(startOfCalendarWeek);

    const [
      todayCab,     todayWalk,
      yesterdayCab, yesterdayWalk,
      weekCab,      weekWalk,
      lastWeekCab,  lastWeekWalk,
      monthCab,     monthWalk,
      lastMonthCab, lastMonthWalk,
      lifetimeCab,  lifetimeWalk,
    ] = await Promise.all([
      CabEscortTrip.countDocuments({ createdAt: { $gte: startOfDay } }),
      WalkSession.countDocuments({   createdAt: { $gte: startOfDay } }),

      CabEscortTrip.countDocuments({ createdAt: { $gte: startOfYesterday, $lt: startOfDay } }),
      WalkSession.countDocuments({   createdAt: { $gte: startOfYesterday, $lt: startOfDay } }),

      // Current calendar week (Monday-start), clipped to month-to-date
      CabEscortTrip.countDocuments({ createdAt: { $gte: startOfWeek } }),
      WalkSession.countDocuments({   createdAt: { $gte: startOfWeek } }),

      CabEscortTrip.countDocuments({ createdAt: { $gte: startOfLastWeek, $lt: endOfLastWeek } }),
      WalkSession.countDocuments({   createdAt: { $gte: startOfLastWeek, $lt: endOfLastWeek } }),

      CabEscortTrip.countDocuments({ createdAt: { $gte: startOfMonth } }),
      WalkSession.countDocuments({   createdAt: { $gte: startOfMonth } }),

      CabEscortTrip.countDocuments({ createdAt: { $gte: startOfLastMonth, $lt: endOfLastMonth } }),
      WalkSession.countDocuments({   createdAt: { $gte: startOfLastMonth, $lt: endOfLastMonth } }),

      // True lifetime totals — all records ever created
      CabEscortTrip.countDocuments({}),
      WalkSession.countDocuments({}),
    ]);

    res.json({
      today:     { cab: todayCab,      walk: todayWalk },
      yesterday: { cab: yesterdayCab,  walk: yesterdayWalk },
      week:      { cab: weekCab,       walk: weekWalk },
      lastWeek:  { cab: lastWeekCab,   walk: lastWeekWalk },
      month:     { cab: monthCab,      walk: monthWalk },
      lastMonth: { cab: lastMonthCab,  walk: lastMonthWalk },
      lifetime:  { cab: lifetimeCab,   walk: lifetimeWalk },
    });
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
