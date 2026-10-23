import React, { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/context/AuthContext";
import { mobileOrNone, unitSerialsSummary } from "@recd/shared";

interface SiteRow {
  id: string;
  address: string | null;
  currentStage: { label: string; phase: string };
  order: { orderNumber: string; customer: { name: string } };
  units?: Array<{ id: string; serialNo: string | null; status: string }>;
  sitePocName?: string | null;
  sitePocNumber?: string | null;
}

export default function MySitesScreen({ navigation }: { navigation: any }) {
  const { logout } = useAuth();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api<SiteRow[]>("/sites?assigned_to=me");
      setSites(data);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={sites}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        ListEmptyComponent={<Text style={styles.empty}>No sites assigned yet.</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => navigation.navigate("SiteDetail", { siteId: item.id })}>
            <Text style={styles.cardTitle}>{item.order.orderNumber}</Text>
            <Text style={styles.cardSubtitle}>{item.order.customer.name}</Text>
            <Text style={styles.cardSerial} testID={`serials-${item.id}`}>S/N: {unitSerialsSummary(item.units)}</Text>
            {(item.sitePocName || item.sitePocNumber) && (
              <Text style={styles.cardSerial}>
                Site POC: {item.sitePocName?.trim() || "Name not on file"} · {mobileOrNone(item.sitePocNumber)}
              </Text>
            )}
            <Text style={styles.cardStage}>
              {item.currentStage.label} · {item.currentStage.phase}
            </Text>
          </Pressable>
        )}
      />
      <Pressable onPress={logout}>
        <Text style={styles.logout}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  empty: { textAlign: "center", marginTop: 40, color: "#999" },
  card: { borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10, padding: 14, marginBottom: 10 },
  cardTitle: { fontWeight: "600", fontSize: 15 },
  cardSubtitle: { color: "#666", marginTop: 2 },
  cardSerial: { color: "#374151", marginTop: 2, fontSize: 12 },
  cardStage: { color: "#2563eb", marginTop: 6, fontSize: 13 },
  logout: { textAlign: "center", color: "#dc2626", padding: 12 },
});
