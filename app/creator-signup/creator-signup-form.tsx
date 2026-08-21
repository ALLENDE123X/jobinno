"use client";

/**
 * The creator signup form itself (JOB-042). `page.tsx` is the server half: it
 * owns `PageShell`, the header and the surrounding page, on the same split
 * `app/login/login-form.tsx` uses for the same reason.
 *
 * The insert is a direct client side call to Supabase through
 * `lib/creator-signup.ts`, on the same reasoning `lib/waitlist.ts` documents:
 * RLS on `creators` allows an anonymous insert outright, so there is no
 * server route for this to post to, and none needs to exist.
 *
 * ── The payout tag label swaps with the payout method ────────────────────────
 * `payoutTag` is one column, `payout_tag`, holding either a phone number or a
 * payment app username depending on `payoutMethod`. Swapping the label rather
 * than showing two fields keeps the form asking one question at a time about
 * where the money goes, and `phoneNumber` below stays the one place the form
 * asks for a general contact number, which is a different fact even when a
 * creator picks Zelle and both happen to be phone numbers.
 */

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import {
  submitCreatorSignup,
  CREATOR_PAYOUT_METHOD_OPTIONS,
  type CreatorPayoutMethod,
} from "@/lib/creator-signup";

/**
 * `createClient` throws when the project is not configured. Same shape of
 * message `app/login/login-form.tsx` and `components/landing/waitlist-form.tsx`
 * show for the same failure, so nothing in Jobinno disagrees about what is
 * wrong when Supabase env vars are missing.
 */
const CONFIG_ERROR_MESSAGE =
  "Creator signup is not configured in this environment yet.";

const GENERIC_ERROR_MESSAGE =
  "Something went wrong. Please try again in a moment.";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "joined"; referralLink: string }
  | { kind: "error"; message: string };

/** The label above the payout tag field, which depends on the chosen method. */
function payoutTagLabel(method: CreatorPayoutMethod | ""): string {
  if (method === "zelle") return "Phone number";
  if (method === "venmo" || method === "cashapp") return "Username or tag";
  return "Payout phone number or username";
}

export function CreatorSignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [refCode, setRefCode] = useState("");
  const [instagramHandle, setInstagramHandle] = useState("");
  const [linkedinHandle, setLinkedinHandle] = useState("");
  const [tiktokHandle, setTiktokHandle] = useState("");
  const [twitterHandle, setTwitterHandle] = useState("");
  const [otherSocial, setOtherSocial] = useState("");
  const [payoutMethod, setPayoutMethod] = useState<CreatorPayoutMethod | "">(
    ""
  );
  const [payoutTag, setPayoutTag] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function reset() {
    setName("");
    setEmail("");
    setRefCode("");
    setInstagramHandle("");
    setLinkedinHandle("");
    setTiktokHandle("");
    setTwitterHandle("");
    setOtherSocial("");
    setPayoutMethod("");
    setPayoutTag("");
    setPhoneNumber("");
    setStatus({ kind: "idle" });
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setStatus({ kind: "submitting" });

    let client: ReturnType<typeof createClient>;
    try {
      client = createClient();
    } catch {
      setStatus({ kind: "error", message: CONFIG_ERROR_MESSAGE });
      return;
    }

    try {
      const result = await submitCreatorSignup(client, {
        name,
        email,
        refCode,
        instagramHandle,
        linkedinHandle,
        tiktokHandle,
        twitterHandle,
        otherSocial,
        payoutMethod,
        payoutTag,
        phoneNumber,
      });

      if (!result.ok) {
        setStatus({ kind: "error", message: result.message });
        return;
      }

      setStatus({ kind: "joined", referralLink: result.referralLink });
    } catch (error) {
      console.error("Jobinno could not create that creator signup.", error);
      setStatus({ kind: "error", message: GENERIC_ERROR_MESSAGE });
    }
  }

  return (
    <Card className="w-full max-w-md text-left shadow-xl">
      <CardHeader>
        <CardTitle className="text-2xl">Join the creator program</CardTitle>
        <CardDescription className="text-base">
          Pick your referral code, tell us where to find you, and get your
          link the moment you submit. No waiting on us to set you up.
        </CardDescription>
      </CardHeader>

      <CardContent>
        {status.kind === "joined" ? (
          <div className="space-y-4" role="status">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>You are all set</AlertTitle>
              <AlertDescription>
                Your link:{" "}
                <a
                  href={status.referralLink}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium underline"
                >
                  {status.referralLink}
                </a>
                . Start sharing it.
              </AlertDescription>
            </Alert>
            <Button variant="outline" onClick={reset}>
              Sign up another creator
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor="creator-name">Name</Label>
              <Input
                id="creator-name"
                name="name"
                autoComplete="name"
                placeholder="Courtney Lee"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={status.kind === "submitting"}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="creator-email">Email</Label>
              <Input
                id="creator-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={status.kind === "submitting"}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="creator-ref-code">Referral code</Label>
              <Input
                id="creator-ref-code"
                name="refCode"
                placeholder="courtney"
                value={refCode}
                onChange={(event) => setRefCode(event.target.value)}
                disabled={status.kind === "submitting"}
                required
              />
              <p className="text-sm text-muted-foreground">
                3 to 20 characters: lowercase letters, numbers, dashes or
                underscores. This becomes jobinno.app/?ref={refCode || "yourcode"}.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <Label className="text-sm font-medium">Social profiles</Label>
                <p className="text-sm text-muted-foreground">
                  Add at least one so we can verify your audience.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="creator-instagram">
                  Instagram{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="creator-instagram"
                  name="instagramHandle"
                  placeholder="@handle"
                  value={instagramHandle}
                  onChange={(event) => setInstagramHandle(event.target.value)}
                  disabled={status.kind === "submitting"}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="creator-linkedin">
                  LinkedIn{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="creator-linkedin"
                  name="linkedinHandle"
                  placeholder="linkedin.com/in/handle"
                  value={linkedinHandle}
                  onChange={(event) => setLinkedinHandle(event.target.value)}
                  disabled={status.kind === "submitting"}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="creator-tiktok">
                  TikTok{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="creator-tiktok"
                  name="tiktokHandle"
                  placeholder="@handle"
                  value={tiktokHandle}
                  onChange={(event) => setTiktokHandle(event.target.value)}
                  disabled={status.kind === "submitting"}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="creator-twitter">
                  Twitter{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="creator-twitter"
                  name="twitterHandle"
                  placeholder="@handle"
                  value={twitterHandle}
                  onChange={(event) => setTwitterHandle(event.target.value)}
                  disabled={status.kind === "submitting"}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="creator-other-social">
                  Other social{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="creator-other-social"
                  name="otherSocial"
                  placeholder="Your channel or profile"
                  value={otherSocial}
                  onChange={(event) => setOtherSocial(event.target.value)}
                  disabled={status.kind === "submitting"}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="creator-payout-method">Payout method</Label>
              <Select
                value={payoutMethod}
                onValueChange={(next) =>
                  setPayoutMethod(next as CreatorPayoutMethod)
                }
              >
                <SelectTrigger id="creator-payout-method" className="w-full">
                  <SelectValue placeholder="Choose how you want to get paid" />
                </SelectTrigger>
                <SelectContent>
                  {CREATOR_PAYOUT_METHOD_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="creator-payout-tag">
                {payoutTagLabel(payoutMethod)}
              </Label>
              <Input
                id="creator-payout-tag"
                name="payoutTag"
                placeholder={
                  payoutMethod === "zelle" ? "555 123 4567" : "@handle"
                }
                value={payoutTag}
                onChange={(event) => setPayoutTag(event.target.value)}
                disabled={status.kind === "submitting"}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="creator-phone">Phone number</Label>
              <Input
                id="creator-phone"
                name="phoneNumber"
                type="tel"
                autoComplete="tel"
                placeholder="555 123 4567"
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                disabled={status.kind === "submitting"}
                required
              />
              <p className="text-sm text-muted-foreground">
                A general contact number, separate from your payout tag above.
              </p>
            </div>

            {status.kind === "error" ? (
              <p className="text-sm text-destructive" role="alert">
                {status.message}
              </p>
            ) : null}

            <Button
              type="submit"
              size="lg"
              className="h-10 w-full text-sm"
              disabled={status.kind === "submitting"}
            >
              {status.kind === "submitting" ? "Submitting" : "Get my link"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
