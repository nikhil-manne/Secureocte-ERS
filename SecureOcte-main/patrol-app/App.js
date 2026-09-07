import React, { useContext, useEffect } from "react";
import { View, ActivityIndicator, StyleSheet, StatusBar } from "react-native";
import * as Notifications from "expo-notifications";
import { AuthProvider, AuthContext } from "./screens/AuthContext";
import AuthScreen from "./screens/AuthScreen";
import PatrolVehicleScreen from "./screens/Patrolvehiclescreen";
import { connectSocket, disconnectSocket } from "./screens/socket";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function MainApp() {
  const { user, token, loading } = useContext(AuthContext);

  useEffect(() => {
    if (token && user) {
      const userId = user._id || user.id || user.username;
      connectSocket({ token, userId, role: "officer" });
    } else {
      disconnectSocket();
    }
    return () => {
      disconnectSocket();
    };
  }, [token, user]);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#0284c7" />
      </View>
    );
  }

  if (!token) {
    return <AuthScreen />;
  }

  return <PatrolVehicleScreen />;
}

export default function App() {
  return (
    <AuthProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0b1329" />
      <MainApp />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: "#0b1329",
    alignItems: "center",
    justifyContent: "center",
  },
});
