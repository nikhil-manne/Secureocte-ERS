import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Image,
  StatusBar,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import { rawFetchWithSecurity, BASE_URL } from "./api";

// ── Avatar placeholder (robot icon using emoji, no external dep) ─────────────
const BotAvatar = () => (
  <View style={styles.botAvatarWrap}>
    <Text style={styles.botAvatarEmoji}>🤖</Text>
  </View>
);

const UserAvatar = () => (
  <View style={styles.userAvatarWrap}>
    <Text style={styles.userAvatarEmoji}>🧑</Text>
  </View>
);

export default function AIChatScreen({ onBack }) {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      text: "Hello, I'm Neha. An AI created by SecureOcte. My job is to support you until you reach your destination and keep you safe.\n\nYou can ask me about travel safety, do's & don'ts while travelling alone, or simply share your thoughts and feelings.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const scrollRef = useRef();

  useEffect(() => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, [messages, loading]);

  const sendMessage = async () => {
    const msgText = input;
    if (!msgText.trim()) return;

    const userMsg = { role: "user", text: msgText };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res  = await rawFetchWithSecurity(`${BASE_URL}/ai/chat`, {
        method: "POST",
        body: { messages: [...messages, userMsg] },
      });
      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", text: data.reply || "No response received." }]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "I'm having trouble responding. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleChip = (label) => sendMessage(label);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#EDF2EC" />
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
        >
          {/* ── HEADER ──────────────────────────────────────────────────────── */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onBack} style={styles.headerBack} activeOpacity={0.7}>
              <Text style={styles.headerBackArrow}>←</Text>
            </TouchableOpacity>

            <Text style={styles.headerTitle}>AI Safety Assistant</Text>

            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeIcon}>🛡️</Text>
            </View>
          </View>

          {/* ── CHAT MESSAGES ───────────────────────────────────────────────── */}
          <ScrollView
            ref={scrollRef}
            style={styles.chatArea}
            contentContainerStyle={styles.chatContent}
            showsVerticalScrollIndicator={false}
          >
            {messages.map((msg, i) => (
              <View key={i} style={styles.messageRow}>
                {msg.role === "assistant" && (
                  <View style={styles.botRow}>
                    <BotAvatar />
                    <View style={styles.botMeta}>
                      <Text style={styles.botLabel}>AI ASSISTANT</Text>
                      <View style={styles.botBubble}>
                        <Text style={styles.botBubbleText}>{msg.text}</Text>
                      </View>
                    </View>
                  </View>
                )}

                {msg.role === "user" && (
                  <View style={styles.userRow}>
                    <View style={styles.userMeta}>
                      <Text style={styles.userLabel}>YOU</Text>
                      <View style={styles.userBubble}>
                        <Text style={styles.userBubbleText}>{msg.text}</Text>
                      </View>
                    </View>
                    <UserAvatar />
                  </View>
                )}
              </View>
            ))}

            {loading && (
              <View style={styles.botRow}>
                <BotAvatar />
                <View style={styles.botMeta}>
                  <Text style={styles.botLabel}>AI ASSISTANT</Text>
                  <View style={styles.botBubble}>
                    <Text style={styles.typingDots}>● ● ●</Text>
                  </View>
                </View>
              </View>
            )}
          </ScrollView>

          {/* ── INPUT ROW ───────────────────────────────────────────────────── */}
          <View style={styles.inputArea}>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                placeholder="Type a message..."
                placeholderTextColor="#9CA8A5"
                value={input}
                onChangeText={setInput}
                multiline
                onSubmitEditing={() => sendMessage()}
              />
              <TouchableOpacity
                style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
                onPress={() => sendMessage()}
                disabled={!input.trim() && !loading}
                activeOpacity={0.8}
              >
                <Text style={styles.sendBtnIcon}>▶</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.micBtn} activeOpacity={0.7}>
              </TouchableOpacity>
            </View>
          </View>

        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#EDF2EC",
  },

  // ── HEADER ─────────────────────────────────────────────────────────────────
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 36,
    paddingBottom: 14,
    backgroundColor: "#EDF2EC",
    borderBottomWidth: 1,
    borderBottomColor: "#D8E4D6",
  },
  headerBack: {
    width: 36,
    height: 36,
    justifyContent: "center",
  },
  headerBackArrow: {
    fontSize: 24,
    color: "#1A2420",
    fontWeight: "600",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "800",
    color: "#1A2420",
    letterSpacing: 0.2,
  },
  headerBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#CDFAD5",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#22C55E",
  },
  headerBadgeIcon: { fontSize: 18 },

  // ── CHAT ───────────────────────────────────────────────────────────────────
  chatArea: { flex: 1 },
  chatContent: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 10,
    gap: 20,
  },
  messageRow: {},

  // Bot message
  botRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  botAvatarWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#CDFAD5",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1.5,
    borderColor: "#22C55E",
    flexShrink: 0,
  },
  botAvatarEmoji: { fontSize: 20 },
  botMeta: { flex: 1 },
  botLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#22C55E",
    letterSpacing: 1.2,
    marginBottom: 5,
  },
  botBubble: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    borderTopLeftRadius: 4,
    padding: 14,
    maxWidth: "92%",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  botBubbleText: {
    fontSize: 15,
    color: "#1A2420",
    lineHeight: 22,
  },

  // User message
  userRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "flex-end",
    gap: 10,
  },
  userMeta: { alignItems: "flex-end", flex: 1 },
  userLabel: {
    fontSize: 11,
    fontWeight: "800",
    color: "#64748B",
    letterSpacing: 1.2,
    marginBottom: 5,
  },
  userBubble: {
    backgroundColor: "#22C55E",
    borderRadius: 18,
    borderTopRightRadius: 4,
    padding: 14,
    maxWidth: "85%",
    shadowColor: "#22C55E",
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  userBubbleText: {
    fontSize: 15,
    color: "#FFFFFF",
    lineHeight: 22,
    fontWeight: "500",
  },
  userAvatarWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#E2E8F0",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#22C55E",
    flexShrink: 0,
  },
  userAvatarEmoji: { fontSize: 20 },

  // Typing indicator
  typingDots: {
    color: "#22C55E",
    fontSize: 14,
    letterSpacing: 4,
  },

  // ── INPUT ──────────────────────────────────────────────────────────────────
  inputArea: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#EDF2EC",
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFFFFF",
    borderRadius: 50,
    paddingLeft: 18,
    paddingRight: 8,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "#D8E4D6",
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  input: {
    flex: 1,
    fontSize: 15,
    color: "#1A2420",
    paddingVertical: 6,
    maxHeight: 100,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#22C55E",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 6,
    shadowColor: "#22C55E",
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  sendBtnDisabled: {
    backgroundColor: "#A3D9B1",
    shadowOpacity: 0,
    elevation: 0,
  },
  sendBtnIcon: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "800",
    marginLeft: 2,
  },
  micBtn: {
    width: 36,
    height: 36,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 2,
  },
  micIcon: { fontSize: 20 },

});