"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const hasToken = typeof window !== "undefined" && window.localStorage.getItem("recd_token");
    router.replace(hasToken ? "/dashboard" : "/login");
  }, [router]);
  return null;
}
