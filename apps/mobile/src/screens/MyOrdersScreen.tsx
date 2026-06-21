import React, { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, StyleSheet, RefreshControl } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/context/AuthContext";

interface OrderRow {
  id: string;
  orderNumber: string;
  product: { name: string };
  site: { id: string; currentStage: { label: string } } | null;
}

export default function MyOrdersScreen({ navigation }: { navigation: any }) {
  const { logout } = useAuth();
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setOrders(await api<OrderRow[]>("/orders"));
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
        data={orders}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
        ListEmptyComponent={<Text style={styles.empty}>No orders yet.</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            disabled={!item.site}
            onPress={() => item.site && navigation.navigate("OrderDetail", { siteId: item.site.id, orderId: item.id })}
          >
            <Text style={styles.cardTitle}>{item.orderNumber}</Text>
            <Text style={styles.cardSubtitle}>{item.product.name}</Text>
            <Text style={styles.cardStage}>{item.site?.currentStage.label ?? "Not yet scheduled"}</Text>
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
  cardStage: { color: "#2563eb", marginTop: 6, fontSize: 13 },
  logout: { textAlign: "center", color: "#dc2626", padding: 12 },
});
