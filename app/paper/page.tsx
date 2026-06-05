import { redirect } from "next/navigation";

/** Legacy paper dashboard → Wallet is the canonical positions view. */
export default function PaperPage() {
  redirect("/wallet");
}
