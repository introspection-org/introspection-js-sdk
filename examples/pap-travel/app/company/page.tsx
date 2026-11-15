import { poppyDocument } from "@/lib/company/oauth";

/** Flight Sector's home page, for a person: where a Personal Agent starts. */
export default function Page() {
  return (
    <main className="company">
      <div className="company-card">
        <div className="company-brand">Flight Sector</div>
        <p>
          Personal Agents start at{" "}
          <a href="/.well-known/poppy.json">
            <code>/.well-known/poppy.json</code>
          </a>
          :
        </p>
        <pre>{JSON.stringify(poppyDocument(), null, 2)}</pre>
      </div>
    </main>
  );
}
