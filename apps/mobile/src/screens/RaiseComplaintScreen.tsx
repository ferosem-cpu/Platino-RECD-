import React, { useEffect, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView, Image } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { COMPLAINT_CATEGORY, buildComplaintBody, eligibleComplaintUnits, requiresUnitSelection } from "@recd/shared";
import { api } from "@/lib/apiClient";

const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: COMPLAINT_CATEGORY.ERECTION_COMMISSIONING, label: "Erection & commissioning" },
  { key: COMPLAINT_CATEGORY.DELIVERY_DELAY, label: "Delivery schedule / delay" },
  { key: COMPLAINT_CATEGORY.NON_PERFORMANCE, label: "Non-performance of RECD" },
];
const SEVERITIES = ["low", "medium", "high", "critical"] as const;

interface SiteUnit {
  id: string;
  serialNo: string | null;
  status: string;
  product: { name: string; model: string };
}

/** The API client throws JSON-quoted error strings; show them as plain sentences. */
function readableError(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  try {
    const parsed = JSON.parse(err.message);
    if (typeof parsed === "string") return parsed;
  } catch {
    // already plain text
  }
  return err.message;
}

export default function RaiseComplaintScreen({ route, navigation }: { route: any; navigation: any }) {
  const { siteId } = route.params as { siteId: string };
  const [category, setCategory] = useState(CATEGORIES[0].key);
  const [severity, setSeverity] = useState<typeof SEVERITIES[number]>("medium");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [units, setUnits] = useState<SiteUnit[]>([]);
  const [unitId, setUnitId] = useState<string | null>(null);
  // Photo of the RECD / DG name plate - mandatory, same as the web portal's complaint form.
  const [photo, setPhoto] = useState<{ uri: string; dataUrl: string } | null>(null);

  useEffect(() => {
    api<{ units: SiteUnit[] }>(`/sites/${siteId}`)
      .then((site) => setUnits(eligibleComplaintUnits(site.units)))
      .catch(() => setUnits([]));
  }, [siteId]);

  async function takePhoto() {
    const result = await ImagePicker.launchCameraAsync({ quality: 0.4, base64: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset.base64) {
      Alert.alert("Could not read the photo", "Please try again.");
      return;
    }
    setPhoto({ uri: asset.uri, dataUrl: `data:${asset.mimeType ?? "image/jpeg"};base64,${asset.base64}` });
  }

  async function submit() {
    if (description.trim().length === 0) {
      Alert.alert("Please describe the issue");
      return;
    }
    // With several RECDs at the site the ticket has to name the serial it is about; with one the
    // API ties it to that RECD itself.
    if (requiresUnitSelection(units) && !unitId) {
      Alert.alert("Select the RECD serial number this complaint is about");
      return;
    }
    if (!photo) {
      Alert.alert("Please attach a photo of the RECD & DG name plate");
      return;
    }
    setSubmitting(true);
    try {
      await api("/complaints", {
        method: "POST",
        body: JSON.stringify(
          buildComplaintBody({ siteId, unitId, category, description, severity, attachmentUrl: photo.dataUrl }),
        ),
      });
      Alert.alert("Complaint submitted", "Our service team will get back to you.", [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } catch (err) {
      Alert.alert("Could not submit complaint", readableError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container}>
      {units.length > 0 && (
        <>
          <Text style={styles.section}>RECD serial number{requiresUnitSelection(units) ? " *" : ""}</Text>
          <View style={styles.chipRow}>
            {units.map((u) => (
              <Pressable
                key={u.id}
                style={[styles.chip, unitId === u.id && styles.chipSelected]}
                onPress={() => setUnitId(u.id)}
              >
                <Text style={[styles.chipText, unitId === u.id && styles.chipTextSelected]}>
                  {u.serialNo ?? "Serial not recorded"} · {u.product.model}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

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

      <Text style={styles.section}>Photo of RECD & DG name plate *</Text>
      <Pressable style={styles.photoButton} onPress={takePhoto}>
        <Text style={styles.photoButtonText}>{photo ? "Retake photo" : "Take photo"}</Text>
      </Pressable>
      {photo && <Image source={{ uri: photo.uri }} style={styles.photoPreview} />}

      <Pressable style={styles.button} onPress={submit} disabled={submitting}>
        <Text style={styles.buttonText}>{submitting ? "Submitting..." : "Submit complaint"}</Text>
      </Pressable>
    </ScrollView>
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
  photoButton: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 8, padding: 12, alignItems: "center" },
  photoButtonText: { color: "#111827", fontWeight: "600" },
  photoPreview: { width: 160, height: 120, borderRadius: 8, marginTop: 10 },
  button: { backgroundColor: "#111827", borderRadius: 8, padding: 14, alignItems: "center", marginTop: 24 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
