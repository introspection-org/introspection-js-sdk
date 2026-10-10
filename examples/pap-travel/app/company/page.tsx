import { poppyDocument } from "@/lib/company/oauth";

export default function Page() {
  return (
    <main className="company">
      <div className="company-card">
        <div className="company-brand">Flight Sector</div>
        <p>
          This host is Flight Sector&apos;s side of the Personal Agent Protocol.
          Personal Agents start here:
        </p>
        <pre>{JSON.stringify(poppyDocument(), null, 2)}</pre>
      </div>
    </main>
  );
}
