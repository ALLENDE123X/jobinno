// JOB-365. A mock of how few fields intake actually asks for, built from the
// same shadcn/ui primitives the real onboarding form uses.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FIELDS = [
  { id: "resume", label: "Resume", value: "pranav-lende-resume.pdf" },
  { id: "roles", label: "Target roles", value: "Software Engineer, New Grad" },
  { id: "location", label: "Locations", value: "San Francisco, Remote" },
  { id: "authorization", label: "Work authorization", value: "US citizen" },
];

export function IntakeFormShort() {
  return (
    <div className="flex h-full w-full items-center justify-center px-16">
      <div className="w-[720px] space-y-6 rounded-2xl border border-white/10 bg-card p-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">One short intake</h1>
          <p className="text-muted-foreground mt-1">
            4 fields, then Jobinno starts applying on its own.
          </p>
        </div>
        {FIELDS.map((field) => (
          <div key={field.id} className="space-y-2">
            <Label htmlFor={field.id}>{field.label}</Label>
            <Input id={field.id} readOnly value={field.value} className="h-12 text-base" />
          </div>
        ))}
        <Button size="lg" className="w-full">
          Start applying
        </Button>
      </div>
    </div>
  );
}
