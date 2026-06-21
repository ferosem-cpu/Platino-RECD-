import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { api } from "@/lib/apiClient";

interface StageOption {
  id: string;
  label: string;
  phase: string;
}
interface StatusOption {
  id: string;
  label: string;
  requiresComment: boolean;
}
interface PhotoCheckpoint {
  id: string;
  label: string;
}
interface StageEvent {
  id: string;
  comment: string;
  createdAt: string;
  stageDefinition: { label: string };
  statusOption: { label: string };
}
interface SiteDetail {
  id: string;
  currentStage: { id: string; label: string };
  order: { orderNumber: string; plannedExhaustHookupType: string | null };
  confirmedExhaustHookupType: string | null;
  stageEvents: StageEvent[];
  photos: Array<{ id: string; checkpoint: { id: string; label: string }; photoUrl: string }>;
}

export default function SiteDetailScreen({ route }: { route: any }) {
  const { siteId } = route.params as { siteId: string };
  const [site, setSite] = useState<SiteDetail | null>(null);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [statusOptions, setStatusOptions] = useState<StatusOption[]>([]);
  const [checkpoints, setCheckpoints] = useState<PhotoCheckpoint[]>([]);

  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [siteData, stageData, statusData, checkpointData] = await Promise.all([
      api<SiteDetail>(`/sites/${siteId}`),
      api<StageOption[]>("/meta/stages"),
      api<StatusOption[]>("/meta/status-options"),
      api<PhotoCheckpoint[]>("/meta/photo-checkpoints"),
    ]);
    setSite(siteData);
    setStages(stageData);
    setStatusOptions(statusData);
    setCheckpoints(checkpointData);
    setSelectedStage((prev) => prev ?? siteData.currentStage.id);
  }, [siteId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function submitStageEvent() {
    if (!selectedStage || !selectedStatus) {
      Alert.alert("Pick a stage and a status first");
      return;
    }
    const statusDef = statusOptions.find((s) => s.id === selectedStatus);
    if (statusDef?.requiresComment && comment.trim().length === 0) {
      Alert.alert("This status needs a comment");
      return;
    }
    setSubmitting(true);
    try {
      await api(`/sites/${siteId}/stage-events`, {
        method: "POST",
        body: JSON.stringify({ stageDefinitionId: selectedStage, statusOptionId: selectedStatus, comment }),
      });
      setComment("");
      setSelectedStatus(null);
      await load();
    } catch (err) {
      Alert.alert("Could not save update", err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadPhoto(checkpointId: string) {
    const result = await ImagePicker.launchCameraAsync({ quality: 0.6 });
    if (result.canceled) return;
    // Phase 1 placeholder: passes the local device URI straight through. Swap for an
    // upload-to-S3-then-pass-the-resulting-URL step once file storage is wired up.
    const photoUrl = result.assets[0].uri;
    try {
      await api(`/sites/${siteId}/photos`, {
        method: "POST",
        body: JSON.stringify({ checkpointId, photoUrl }),
      });
      await load();
    } catch (err) {
      Alert.alert("Could not upload photo", err instanceof Error ? err.message : undefined);
    }
  }

  if (!site) return <Text style={styles.empty}>Loading...</Text>;

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>{site.order.orderNumber}</Text>
      <Text style={styles.subtitle}>Current stage: {site.currentStage.label}</Text>
      <Text style={styles.subtitle}>
        Exhaust hookup - planned: {site.order.plannedExhaustHookupType ?? "-"}, confirmed:{" "}
        {site.confirmedExhaustHookupType ?? "not confirmed yet"}
      </Text>

      <Text style={styles.section}>Update stage</Text>
      <View style={styles.chipRow}>
        {stages.map((s) => (
          <Pressable
            key={s.id}
            style={[styles.chip, selectedStage === s.id && styles.chipSelected]}
            onPress={() => setSelectedStage(s.id)}
          >
            <Text style={[styles.chipText, selectedStage === s.id && styles.chipTextSelected]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.chipRow}>
        {statusOptions.map((s) => (
          <Pressable
            key={s.id}
            style={[styles.chip, selectedStatus === s.id && styles.chipSelected]}
            onPress={() => setSelectedStatus(s.id)}
          >
            <Text style={[styles.chipText, selectedStatus === s.id && styles.chipTextSelected]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={styles.commentInput}
        placeholder="Comment (reason for delay, or note that work is on time)"
        multiline
        value={comment}
        onChangeText={setComment}
      />
      <Pressable style={styles.button} onPress={submitStageEvent} disabled={submitting}>
        <Text style={styles.buttonText}>{submitting ? "Saving..." : "Save update"}</Text>
      </Pressable>

      <Text style={styles.section}>Photo checkpoints</Text>
      <View style={styles.chipRow}>
        {checkpoints.map((c) => (
          <Pressable key={c.id} style={styles.chip} onPress={() => uploadPhoto(c.id)}>
            <Text style={styles.chipText}>📷 {c.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.section}>History</Text>
      {site.stageEvents.map((e) => (
        <View key={e.id} style={styles.historyRow}>
          <Text style={styles.historyTitle}>
            {e.stageDefinition.label} - {e.statusOption.label}
          </Text>
          <Text style={styles.historyComment}>{e.comment}</Text>
          <Text style={styles.historyDate}>{new Date(e.createdAt).toLocaleString()}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  empty: { textAlign: "center", marginTop: 40, color: "#999" },
  title: { fontSize: 18, fontWeight: "600" },
  subtitle: { color: "#666", marginTop: 4, fontSize: 13 },
  section: { marginTop: 20, marginBottom: 8, fontWeight: "600", fontSize: 14 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipSelected: { backgroundColor: "#111827", borderColor: "#111827" },
  chipText: { fontSize: 13, color: "#374151" },
  chipTextSelected: { color: "#fff" },
  commentInput: {
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
    minHeight: 60,
    fontSize: 14,
  },
  button: { backgroundColor: "#111827", borderRadius: 8, padding: 12, alignItems: "center", marginTop: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  historyRow: { borderTopWidth: 1, borderTopColor: "#f0f0f0", paddingVertical: 10 },
  historyTitle: { fontWeight: "600", fontSize: 13 },
  historyComment: { color: "#555", fontSize: 13, marginTop: 2 },
  historyDate: { color: "#999", fontSize: 11, marginTop: 4 },
});
