import React, { useCallback, useState } from "react";
import { View, Text, ScrollView, Pressable, StyleSheet, Image, Alert } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { api } from "@/lib/apiClient";

interface SiteDetail {
  id: string;
  currentStage: { label: string };
  order: { orderNumber: string };
  stageEvents: Array<{
    id: string;
    comment: string;
    createdAt: string;
    stageDefinition: { label: string };
    statusOption: { label: string };
  }>;
  photos: Array<{ id: string; photoUrl: string; checkpoint: { label: string } }>;
  pendingActions: Array<{ id: string; description: string; status: string; category: string }>;
}

export default function OrderDetailScreen({ route, navigation }: { route: any; navigation: any }) {
  const { siteId } = route.params as { siteId: string };
  const [site, setSite] = useState<SiteDetail | null>(null);

  const load = useCallback(async () => {
    setSite(await api<SiteDetail>(`/sites/${siteId}`));
  }, [siteId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function resolvePendingAction(actionId: string, resolution: "keep_existing" | "replace_with_recd") {
    try {
      await api(`/pending-actions/${actionId}/resolve`, { method: "POST", body: JSON.stringify({ resolution }) });
      await load();
    } catch (err) {
      Alert.alert("Could not submit your decision", err instanceof Error ? err.message : undefined);
    }
  }

  if (!site) return <Text style={styles.empty}>Loading...</Text>;
  const openActions = site.pendingActions.filter((a) => a.status === "open");

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>{site.order.orderNumber}</Text>
      <Text style={styles.subtitle}>Current stage: {site.currentStage.label}</Text>

      {openActions.map((action) => (
        <View key={action.id} style={styles.pendingCard}>
          <Text style={styles.pendingText}>{action.description}</Text>
          {action.category === "customer_approval" && (
            <View style={styles.pendingButtonRow}>
              <Pressable style={styles.pendingButton} onPress={() => resolvePendingAction(action.id, "keep_existing")}>
                <Text style={styles.pendingButtonText}>Keep existing filter</Text>
              </Pressable>
              <Pressable style={styles.pendingButton} onPress={() => resolvePendingAction(action.id, "replace_with_recd")}>
                <Text style={styles.pendingButtonText}>Replace with RECD</Text>
              </Pressable>
            </View>
          )}
        </View>
      ))}

      <Text style={styles.section}>Progress</Text>
      {site.stageEvents.map((e) => (
        <View key={e.id} style={styles.historyRow}>
          <Text style={styles.historyTitle}>
            {e.stageDefinition.label} - {e.statusOption.label}
          </Text>
          <Text style={styles.historyComment}>{e.comment}</Text>
          <Text style={styles.historyDate}>{new Date(e.createdAt).toLocaleString()}</Text>
        </View>
      ))}

      <Text style={styles.section}>Photos</Text>
      <ScrollView horizontal>
        {site.photos.map((p) => (
          <View key={p.id} style={{ marginRight: 10 }}>
            <Image source={{ uri: p.photoUrl }} style={styles.photo} />
            <Text style={styles.photoLabel}>{p.checkpoint.label}</Text>
          </View>
        ))}
      </ScrollView>

      <Pressable style={styles.button} onPress={() => navigation.navigate("RaiseComplaint", { siteId: site.id })}>
        <Text style={styles.buttonText}>Raise a complaint</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  empty: { textAlign: "center", marginTop: 40, color: "#999" },
  title: { fontSize: 18, fontWeight: "600" },
  subtitle: { color: "#666", marginTop: 4, fontSize: 13 },
  section: { marginTop: 20, marginBottom: 8, fontWeight: "600", fontSize: 14 },
  pendingCard: { backgroundColor: "#fef3c7", borderRadius: 10, padding: 12, marginTop: 14 },
  pendingText: { color: "#92400e", fontSize: 13 },
  pendingButtonRow: { flexDirection: "row", gap: 8, marginTop: 10 },
  pendingButton: { flex: 1, backgroundColor: "#92400e", borderRadius: 8, padding: 10, alignItems: "center" },
  pendingButtonText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  historyRow: { borderTopWidth: 1, borderTopColor: "#f0f0f0", paddingVertical: 10 },
  historyTitle: { fontWeight: "600", fontSize: 13 },
  historyComment: { color: "#555", fontSize: 13, marginTop: 2 },
  historyDate: { color: "#999", fontSize: 11, marginTop: 4 },
  photo: { width: 100, height: 100, borderRadius: 8, backgroundColor: "#eee" },
  photoLabel: { fontSize: 11, color: "#666", marginTop: 4, maxWidth: 100 },
  button: { backgroundColor: "#111827", borderRadius: 8, padding: 12, alignItems: "center", marginTop: 20, marginBottom: 30 },
  buttonText: { color: "#fff", fontWeight: "600" },
});
