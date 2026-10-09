"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/api";

/** Entry point: send users to the dashboard when authenticated, else login. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? "/ask" : "/login");
  }, [router]);
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-2 border-t-brand-2" />
    </div>
  );
}
