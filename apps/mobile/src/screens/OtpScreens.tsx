import React, { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import {
  LOGIN_OTP_POLICY,
  canResend,
  otpErrorText,
  otpExpiryText,
  otpRequestedNotice,
  resendLabel,
  tickCooldown,
} from "@recd/shared";
import { useAuth } from "@/context/AuthContext";
import { ApiRequestError } from "@/lib/apiClient";

/** The API sends plain-string errors JSON-quoted (see apiClient); turn that back into a sentence. */
function readableMessage(err: unknown): string {
  if (!(err instanceof Error)) return "";
  try {
    const parsed: unknown = JSON.parse(err.message);
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return err.message;
  }
}

function errorInfo(err: unknown) {
  const status = err instanceof ApiRequestError ? err.status : undefined;
  const retry = err instanceof ApiRequestError ? Number(err.body.retryAfterSeconds) || undefined : undefined;
  return { status, message: readableMessage(err), retryAfterSeconds: retry };
}

export function OtpRequestScreen({ navigation }: { navigation: any }) {
  const { requestOtp } = useAuth();
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      const result = await requestOtp(phone);
      navigation.navigate("OtpVerify", { phone, result });
    } catch (err) {
      setError(otpErrorText("request", errorInfo(err)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sign in</Text>
      <Text style={styles.subtitle}>
        Enter the mobile number registered on your account. We'll send a one-time code to it on WhatsApp.
      </Text>
      <TextInput
        style={styles.input}
        placeholder="Registered mobile number"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={handleSubmit} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? "Sending..." : "Send code"}</Text>
      </Pressable>
    </View>
  );
}

export function OtpVerifyScreen({ route }: { route: any }) {
  const { verifyOtp, requestOtp } = useAuth();
  const { phone, result } = route.params as { phone: string; result?: import("@/context/AuthContext").OtpRequestResponse };
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(result?.resendAfterSeconds ?? LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS);
  const [expiresIn, setExpiresIn] = useState(result?.expiresInSeconds ?? LOGIN_OTP_POLICY.EXPIRY_SECONDS);
  const [notice, setNotice] = useState<string | null>(result ? otpRequestedNotice(result, LOGIN_OTP_POLICY.EXPIRY_SECONDS) : null);
  // Local-development echo only: never shown in a release build, so ordinary users cannot be shown a code.
  const [devCode, setDevCode] = useState<string | undefined>(result?.devCode);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => tickCooldown(c)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function handleSubmit() {
    setLoading(true);
    setError(null);
    try {
      await verifyOtp(phone, code);
    } catch (err) {
      setError(otpErrorText("verify", errorInfo(err)));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setLoading(true);
    setError(null);
    try {
      const r = await requestOtp(phone);
      setCode("");
      setCooldown(r.resendAfterSeconds ?? LOGIN_OTP_POLICY.RESEND_COOLDOWN_SECONDS);
      setExpiresIn(r.expiresInSeconds ?? LOGIN_OTP_POLICY.EXPIRY_SECONDS);
      setNotice(otpRequestedNotice(r, LOGIN_OTP_POLICY.EXPIRY_SECONDS));
      setDevCode(r.devCode);
    } catch (err) {
      const info = errorInfo(err);
      if (info.status === 429 && info.retryAfterSeconds && info.retryAfterSeconds < 120) setCooldown(info.retryAfterSeconds);
      setError(otpErrorText("request", info));
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Enter code</Text>
      <Text style={styles.subtitle}>
        {notice ?? "Enter the code sent to your registered mobile number on WhatsApp."}
      </Text>
      {__DEV__ && devCode ? <Text style={styles.subtitle}>Development mode - nothing was sent. Code: {devCode}</Text> : null}
      <TextInput
        style={styles.input}
        placeholder="6-digit code"
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
      />
      <Text style={styles.hint}>Code valid for {otpExpiryText(expiresIn)}.</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <Pressable style={styles.button} onPress={handleSubmit} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? "Please wait..." : "Verify"}</Text>
      </Pressable>
      <Pressable onPress={handleResend} disabled={!canResend(cooldown, loading)} style={styles.linkButton}>
        <Text style={[styles.linkText, !canResend(cooldown, loading) && styles.linkDisabled]}>{resendLabel(cooldown)}</Text>
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
  hint: { color: "#666", fontSize: 12 },
  linkButton: { alignItems: "center", padding: 8 },
  linkText: { color: "#111827", fontWeight: "600" },
  linkDisabled: { color: "#9ca3af" },
});
