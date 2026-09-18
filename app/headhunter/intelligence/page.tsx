import IntelligencePanel from "@/components/IntelligencePanel";

export const dynamic = "force-dynamic";

export default async function IntelligencePage({ searchParams }: {
  searchParams: Promise<{ companyId?: string | string[]; viewId?: string | string[] }>;
}) {
  const params = await searchParams;
  return <IntelligencePanel
    companyId={typeof params.companyId === "string" ? params.companyId : undefined}
    initialViewId={typeof params.viewId === "string" ? params.viewId : undefined}
  />;
}
