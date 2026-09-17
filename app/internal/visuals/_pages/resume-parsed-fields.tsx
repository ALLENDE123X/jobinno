// JOB-365. Resume upload panel on the left, detected fields as tags
// floating out to the right, matching the ticket's layout description.
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const DETECTED = [
  "Name: Pranav Lende",
  "Email: pranavlende123@gmail.com",
  "School: Georgia Tech",
  "Grad year: 2027",
  "Skill: TypeScript",
  "Skill: React",
  "Skill: Postgres",
  "Prior internship: Datadog",
];

export function ResumeParsedFields() {
  return (
    <div className="flex h-full w-full items-center gap-16 px-16">
      <Card className="w-[520px] gap-3 border-white/10 border-dashed">
        <CardContent className="flex flex-col items-center justify-center gap-3 py-20">
          <p className="text-xl font-medium">pranav-lende-resume.pdf</p>
          <p className="text-muted-foreground">Parsing complete</p>
        </CardContent>
      </Card>
      <div className="flex flex-1 flex-wrap gap-3">
        {DETECTED.map((field) => (
          <Badge key={field} variant="secondary" className="px-4 py-2 text-base">
            {field}
          </Badge>
        ))}
      </div>
    </div>
  );
}
