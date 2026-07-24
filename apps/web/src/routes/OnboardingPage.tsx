import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { equityPct, coreSharePct, themeCountRange, type RiskAppetite } from '@niveshetf/engine';
import { useAuth } from '@/hooks/useAuth';
import { useUpsertProfileMutation } from '@/store/api';
import { RISK_QUIZ_QUESTIONS, scoreToRiskAppetite } from '@/lib/riskQuiz';
import { formatPaise } from '@/lib/money';
import { Disclaimer } from '@/components/Disclaimer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Progress } from '@/components/ui/progress';

const STEP_COUNT = 3;

function ageFromDob(dobIso: string): number {
  const dob = new Date(`${dobIso}T00:00:00.000Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = now.getUTCMonth() < dob.getUTCMonth() || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export default function OnboardingPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [upsertProfile, { isLoading: saving }] = useUpsertProfileMutation();

  const [step, setStep] = useState(1);
  const [dob, setDob] = useState('');
  const [answers, setAnswers] = useState<Record<string, 1 | 2 | 3>>({});
  const [amountRupees, setAmountRupees] = useState('');
  const [nonEquitySleeve, setNonEquitySleeve] = useState<'gold' | 'debt'>('gold');
  const [importHoldingsAfter, setImportHoldingsAfter] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAnswered = Object.keys(answers).length === RISK_QUIZ_QUESTIONS.length;
  const risk: RiskAppetite | null = allAnswered
    ? scoreToRiskAppetite(Object.values(answers).reduce((s, v) => s + v, 0))
    : null;

  const age = dob ? ageFromDob(dob) : null;

  const derived = useMemo(() => {
    if (age === null || !risk) return null;
    const eq = equityPct(age, risk);
    const core = coreSharePct(risk);
    const themes = themeCountRange(risk);
    return { eq, core, themes };
  }, [age, risk]);

  function canProceedFromStep1(): boolean {
    return dob !== '' && age !== null && age >= 18 && age <= 100 && allAnswered;
  }

  function canProceedFromStep2(): boolean {
    const n = Number(amountRupees);
    return amountRupees !== '' && Number.isFinite(n) && n >= 0;
  }

  async function handleFinish() {
    if (!session || !risk) return;
    setError(null);
    const amountPaise = BigInt(Math.round(Number(amountRupees) * 100));
    try {
      await upsertProfile({
        user_id: session.user.id,
        dob,
        risk,
        default_amount_paise: amountPaise.toString(),
        non_equity_sleeve: nonEquitySleeve,
      }).unwrap();
      navigate(importHoldingsAfter ? '/portfolio' : '/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save your profile — please try again.');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>Set up your investing profile</CardTitle>
          <CardDescription>Step {step} of {STEP_COUNT}</CardDescription>
          <Progress value={(step / STEP_COUNT) * 100} className="mt-2" />
        </CardHeader>
        <CardContent className="space-y-6">
          {step === 1 && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="dob">Date of birth</Label>
                <Input id="dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
              </div>
              <div className="space-y-5">
                {RISK_QUIZ_QUESTIONS.map((q) => (
                  <div key={q.id} className="space-y-2">
                    <Label>{q.prompt}</Label>
                    <RadioGroup
                      value={answers[q.id]?.toString() ?? ''}
                      onValueChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: Number(v) as 1 | 2 | 3 }))}
                    >
                      {q.options.map((opt) => (
                        <div key={opt.label} className="flex items-center gap-2">
                          <RadioGroupItem value={opt.score.toString()} id={`${q.id}-${opt.score}`} />
                          <Label htmlFor={`${q.id}-${opt.score}`} className="font-normal">{opt.label}</Label>
                        </div>
                      ))}
                    </RadioGroup>
                  </div>
                ))}
              </div>
              <Button className="w-full" disabled={!canProceedFromStep1()} onClick={() => setStep(2)}>
                Continue
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="amount">Monthly investable amount (₹)</Label>
                <Input
                  id="amount"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="25000"
                  value={amountRupees}
                  onChange={(e) => setAmountRupees(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Editable per run — this is just a default.</p>
              </div>
              <div className="space-y-2">
                <Label>Non-equity sleeve</Label>
                <RadioGroup value={nonEquitySleeve} onValueChange={(v) => setNonEquitySleeve(v as 'gold' | 'debt')}>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="gold" id="sleeve-gold" />
                    <Label htmlFor="sleeve-gold" className="font-normal">Gold (default)</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem value="debt" id="sleeve-debt" />
                    <Label htmlFor="sleeve-debt" className="font-normal">Debt / liquid (more conservative)</Label>
                  </div>
                </RadioGroup>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
                <Button className="flex-1" disabled={!canProceedFromStep2()} onClick={() => setStep(3)}>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {step === 3 && derived && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-medium mb-3">Your derived glide path</h3>
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-md border border-border p-3">
                    <dt className="text-muted-foreground">Equity allocation</dt>
                    <dd className="text-lg font-semibold tabular-nums">{derived.eq}%</dd>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <dt className="text-muted-foreground">Non-equity ({nonEquitySleeve})</dt>
                    <dd className="text-lg font-semibold tabular-nums">{100 - derived.eq}%</dd>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <dt className="text-muted-foreground">Core / satellite split</dt>
                    <dd className="text-lg font-semibold tabular-nums">{derived.core}% / {100 - derived.core}%</dd>
                  </div>
                  <div className="rounded-md border border-border p-3">
                    <dt className="text-muted-foreground">Satellite themes</dt>
                    <dd className="text-lg font-semibold tabular-nums">{derived.themes.min}–{derived.themes.max}</dd>
                  </div>
                </dl>
                <p className="text-xs text-muted-foreground mt-2">
                  Risk profile: <span className="font-medium text-foreground">{risk}</span> · Monthly default: {formatPaise(BigInt(Math.round(Number(amountRupees) * 100)))}
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={importHoldingsAfter}
                  onChange={(e) => setImportHoldingsAfter(e.target.checked)}
                  className="size-4 rounded border-input"
                />
                I already hold ETFs — take me to import them after this
              </label>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
                <Button className="flex-1" disabled={saving} onClick={handleFinish}>
                  {saving ? 'Saving…' : 'Finish setup'}
                </Button>
              </div>

              <Disclaimer />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
