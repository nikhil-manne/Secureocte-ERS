import React, { createContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getDeviceId, apiFetch } from "./api";

export const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadUser = async () => {
      try {
        const stored = await AsyncStorage.getItem("userData");
        const storedToken = await AsyncStorage.getItem("userToken");
        if (stored) setUser(JSON.parse(stored));
        if (storedToken) {
          setToken(storedToken);
          try {
            const me = await apiFetch("/api/auth/me", {}, storedToken);
            if (me && me.username) {
              setUser(me);
              await AsyncStorage.setItem("userData", JSON.stringify(me));
            }
          } catch (e) {
            console.warn("[Auth] Failed to refresh profile on load:", e.message);
          }
        }
      } catch (e) {
        console.warn("Failed to load auth data:", e);
      } finally {
        setLoading(false);
      }
    };
    loadUser();
  }, []);

  const login = async (userData, jwtToken) => {
    setUser(userData);
    setToken(jwtToken);
    await AsyncStorage.setItem("userData", JSON.stringify(userData));
    await AsyncStorage.setItem("userToken", jwtToken);
    try {
      const me = await apiFetch("/api/auth/me", {}, jwtToken);
      if (me && me.username) {
        setUser(me);
        await AsyncStorage.setItem("userData", JSON.stringify(me));
      }
    } catch (e) {
      console.warn("[Auth] Failed to refresh profile on login:", e.message);
    }
  };

  const logout = async () => {
    setUser(null);
    setToken(null);
    await AsyncStorage.removeItem("userData");
    await AsyncStorage.removeItem("userToken");
  };

  const updateUser = async (updated) => {
    setUser(updated);
    await AsyncStorage.setItem("userData", JSON.stringify(updated));
  };

  const authHeaders = (extra = {}) => ({
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  const authHeadersAsync = async (extra = {}) => {
    const deviceId = await getDeviceId();
    return {
      "Content-Type": "application/json",
      "X-Device-Id": deviceId,
      "X-Timestamp": String(Date.now()),
      "X-Nonce": Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    };
  };

  return (
    <AuthContext.Provider
      value={{ user, token, login, logout, updateUser, loading, authHeaders, authHeadersAsync }}
    >
      {children}
    </AuthContext.Provider>
  );
};
