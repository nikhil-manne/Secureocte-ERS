import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import verifyToken from "../middlewares/verifyToken.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("verifyToken accepts valid token with matching device id", () => {
  const token = jwt.sign(
    { userId: "u1", role: "user", deviceId: "device-12345678" },
    process.env.JWT_SECRET
  );

  const req = {
    headers: {
      authorization: `Bearer ${token}`,
      "x-device-id": "device-12345678",
    },
    ip: "127.0.0.1",
  };
  const res = makeRes();
  let nextCalled = false;

  verifyToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.user.userId, "u1");
});

test("verifyToken rejects mismatched device id", () => {
  const token = jwt.sign(
    { userId: "u1", role: "user", deviceId: "device-12345678" },
    process.env.JWT_SECRET
  );

  const req = {
    headers: {
      authorization: `Bearer ${token}`,
      "x-device-id": "device-other",
    },
    ip: "127.0.0.1",
  };
  const res = makeRes();
  let nextCalled = false;

  verifyToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Unauthorized" });
});

test("verifyToken rejects non-admin token without device id", () => {
  const token = jwt.sign(
    { userId: "u1", role: "user" },
    process.env.JWT_SECRET
  );

  const req = {
    headers: {
      authorization: `Bearer ${token}`,
    },
    ip: "127.0.0.1",
  };
  const res = makeRes();
  let nextCalled = false;

  verifyToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Unauthorized" });
});
