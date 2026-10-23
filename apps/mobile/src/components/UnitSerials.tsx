import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { unitLines, type UnitForDisplay } from "@recd/shared";

/** The RECD unit(s) of a site/order with the serial printed on each. A unit without a serial (legacy record) says so. */
export default function UnitSerials({ units }: { units: readonly UnitForDisplay[] | null | undefined }) {
  const lines = unitLines(units);
  if (lines.length === 0) return <Text style={styles.none}>No RECD recorded yet.</Text>;
  return (
    <View>
      {lines.map((u) => (
        <View key={u.id} style={styles.row} testID={`unit-${u.id}`}>
          <Text style={[styles.serial, !u.hasSerial && styles.missing]}>S/N: {u.serial}</Text>
          {u.model ? (
            <Text style={styles.model}>
              {u.model}
              {u.retired ? " · retired" : ""}
            </Text>
          ) : u.retired ? (
            <Text style={styles.model}>retired</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderTopWidth: 1, borderTopColor: "#f0f0f0", paddingVertical: 8 },
  serial: { fontWeight: "600", fontSize: 13 },
  missing: { color: "#92400e", fontWeight: "400" },
  model: { color: "#666", fontSize: 12, marginTop: 2 },
  none: { color: "#999", fontSize: 13 },
});
