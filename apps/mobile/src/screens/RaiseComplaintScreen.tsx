import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert } from "react-native";
import { COMPLAINT_CATEGORY } from "@recd/shared";
import { api } from "@/lib/apiClient";

const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: COMPLAINT_CATEGORY.ERECTION_COMMISSIONING, label: "Erection & commissioning" },
  { key: COMPLAINT_CATEGORY.DELIVERY_DELAY, label: "Delivery schedule / delay" },
  { key: COMPLAINT_CATEGORY.NON_PERFORMANCE, label: "Non-performance of RECD" },
];
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

export default function RaiseComplaintScreen({ route, navigation }: { route: any; navigation: any }) {
  const { siteId } = route.params as { siteId: string };
  const [category, setCategory] = useState(CATEGORIES[0].key);
  const [severity, setSeverity] = useState<typeof SEVERITIES[number]>("medium");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (description.trim().length === 0) {
      Alert.alert("Please describe the issue");
      return;
    }
    setSubmitting(true);
    try {
      await api("/complaints", { method: "POST", body: JSON.stringify({ siteId, category, description, severity }) });
      Alert.alert("Complaint submitted", "Our service team will get back to you.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert("Could not submit complaint", err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.section}>Category</Text>
      <View style={styles.chipRow}>
        {CATEGORIES.map((c) => (
          <Pressable
            key={c.key}
            style={[styles.chip, category === c.key && styles.chipSelected]}
            onPress={() => setCategory(c.key)}
          >
            <Text style={[styles.chipText, category === c.key && styles.chipTextSelected]}>{c.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>Severity</Text>
      <View style={styles.chipRow}>
        {SEVERITIES.map((s) => (
          <Pressable
            key={s}
            style={[styles.chip, severity === s && styles.chipSelected]}
            onPress={() => setSeverity(s)}
          >
            <Text style={[styles.chipText, severity === s && styles.chipTextSelected]}>{s}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>What happened?</Text>
      <TextInput
        style={styles.textArea}
        multiline
        placeholder="Describe the issue"
        value={description}
        onChangeText={setDescription}
      />

      <Pressable style={styles.button} onPress={submit} disabled={submitting}>
        <Text style={styles.buttonText}>{submitting ? "Submitting..." : "Submit complaint"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  section: { marginTop: 16, marginBottom: 8, fontWeight: "600", fontSize: 14 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipSelected: { backgroundColor: "#111827", borderColor: "#111827" },
  chipText: { fontSize: 13, color: "#374151" },
  chipTextSelected: { color: "#fff" },
  textArea: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 10,
    minHeight: 100,
    textAlignVertical: "top",
  },
  button: { backgroundColor: "#111827", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 24 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
