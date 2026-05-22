import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ScansProvider } from "@/src/store/scans";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ScansProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#FAFAFA" } }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="page/[id]" />
          <Stack.Screen name="email" />
        </Stack>
      </ScansProvider>
    </SafeAreaProvider>
  );
}
