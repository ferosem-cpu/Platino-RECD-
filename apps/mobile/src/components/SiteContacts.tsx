import React from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { siteContactLines, telHref, type SiteContactSource } from "@recd/shared";

/**
 * The people at a site (Site POC and the site's contact rows) with their mobile numbers, as returned by the API for the signed-in
 * user's access to that site. Tap a number to call. A person without a number shows "No mobile number on file".
 */
export default function SiteContacts({ site }: { site: SiteContactSource | null | undefined }) {
  const lines = siteContactLines(site);
  if (lines.length === 0) return <Text style={styles.none}>No site contact recorded.</Text>;
  return (
    <View>
      {lines.map((c) => {
        const href = c.hasPhone ? telHref(c.phone) : null;
        return (
          <View key={c.key} style={styles.row} testID={c.key}>
            <Text style={styles.heading}>{c.heading}</Text>
            <Text style={styles.name}>{c.name}</Text>
            {href ? (
              <Pressable onPress={() => Linking.openURL(href)} accessibilityRole="link">
                <Text style={styles.phoneLink}>{c.phone}</Text>
              </Pressable>
            ) : (
              <Text style={[styles.phone, !c.hasPhone && styles.missing]}>{c.phone}</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderTopWidth: 1, borderTopColor: "#f0f0f0", paddingVertical: 8 },
  heading: { color: "#999", fontSize: 11, textTransform: "uppercase" },
  name: { fontWeight: "600", fontSize: 13, marginTop: 2 },
  phone: { color: "#374151", fontSize: 13, marginTop: 2 },
  phoneLink: { color: "#2563eb", fontSize: 13, marginTop: 2 },
  missing: { color: "#92400e" },
  none: { color: "#999", fontSize: 13 },
});
