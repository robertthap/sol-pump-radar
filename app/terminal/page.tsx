import { redirect } from "next/navigation";

/** Legacy terminal → mission control (market trenches at /market). */
export default function TerminalPage() {
  redirect("/mission");
}
