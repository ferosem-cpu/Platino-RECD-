import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useAuth } from "@/context/AuthContext";
import LoginScreen from "@/screens/LoginScreen";
import { OtpRequestScreen, OtpVerifyScreen } from "@/screens/OtpScreens";
import MySitesScreen from "@/screens/MySitesScreen";
import SiteDetailScreen from "@/screens/SiteDetailScreen";
import MyOrdersScreen from "@/screens/MyOrdersScreen";
import OrderDetailScreen from "@/screens/OrderDetailScreen";
import RaiseComplaintScreen from "@/screens/RaiseComplaintScreen";

const Stack = createNativeStackNavigator();

/** Roles that get the field-team experience (site list + stage updates). Everything
 *  else that's authenticated and not "customer" falls back to the same field stack for
 *  now (operations_pm, commissioning_engineer, etc.) - Phase 1 only really exercises
 *  erection_engineer here, see project notes on which roles are active in Phase 1. */
function isFieldRole(role: string) {
  return role !== "customer";
}

export default function RootNavigator() {
  const { user, loading } = useAuth();
  if (loading) return null;

  return (
    <NavigationContainer>
      <Stack.Navigator>
        {!user ? (
          <>
            <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
            <Stack.Screen name="OtpRequest" component={OtpRequestScreen} options={{ title: "Customer sign in" }} />
            <Stack.Screen name="OtpVerify" component={OtpVerifyScreen} options={{ title: "Verify code" }} />
          </>
        ) : isFieldRole(user.role) ? (
          <>
            <Stack.Screen name="MySites" component={MySitesScreen} options={{ title: "My sites" }} />
            <Stack.Screen name="SiteDetail" component={SiteDetailScreen} options={{ title: "Site detail" }} />
          </>
        ) : (
          <>
            <Stack.Screen name="MyOrders" component={MyOrdersScreen} options={{ title: "My orders" }} />
            <Stack.Screen name="OrderDetail" component={OrderDetailScreen} options={{ title: "Order detail" }} />
            <Stack.Screen name="RaiseComplaint" component={RaiseComplaintScreen} options={{ title: "Raise a complaint" }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
