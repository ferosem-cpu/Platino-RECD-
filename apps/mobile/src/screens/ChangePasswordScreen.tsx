import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { MIN_PASSWORD_LENGTH } from "@recd/shared";
import { useAuth } from "@/context/AuthContext";

/**
 * Shown instead of every other screen while the server says this account must change its password (mustChangePassword). The API refuses all
 * other calls until it is done, so nothing else is loaded here. On success the server revokes the old sessions and answers with a fresh token,
 * which AuthContext stores.
 */
export default function ChangePasswordScreen() {
  const { changePassword, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);
    if (newPassword !== confirm) return setError("New passwords do not match");
    if (newPassword.length < MIN_PASSWORD_LENGTH) return setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      let message = "Could not change the password. Check your current password and try again.";
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === "string") message = parsed;
      } catch {
        // not JSON: keep the generic message (never show internals)
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Change your password</Text>
      <Text style={styles.subtitle}>For security, you must choose a new password before continuing.</Text>
      <TextInput style={styles.input} placeholder="Current password" secureTextEntry value={currentPassword} onChangeText={setCurrentPassword} />
      <TextInput style={styles.input} placeholder="New password" secureTextEntry value={newPassword} onChangeText={setNewPassword} />
      <TextInput style={styles.input} placeholder="Confirm new password" secureTextEntry value={confirm} onChangeText={setConfirm} />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={submit} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "Updating..." : "Update password"}</Text>
      </Pressable>
      <Pressable onPress={() => void logout()}>
        <Text style={styles.link}>Cancel and sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: "600" },
  subtitle: { fontSize: 14, color: "#666", marginBottom: 12 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, fontSize: 15 },
  button: { backgroundColor: "#111827", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 8 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626", fontSize: 13 },
  link: { color: "#2563eb", textAlign: "center", marginTop: 16, fontSize: 13 },
});
