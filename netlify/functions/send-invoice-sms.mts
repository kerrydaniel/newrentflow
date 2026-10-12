import { createClient } from "@supabase/supabase-js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function normalizeKenyanPhone(input: string) {
  const digits = input.replace(/[^0-9]/g, "");
  if (digits.startsWith("254") && digits.length === 12) return "+" + digits;
  if (digits.startsWith("0") && digits.length === 10) return "+254" + digits.slice(1);
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return "+254" + digits;
  return null;
}

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ error: "Sign in to send invoice SMS messages." }, 401);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const username = Netlify.env.get("AT_USERNAME");
  const apiKey = Netlify.env.get("AT_API_KEY");
  const senderId = Netlify.env.get("AT_SENDER_ID");
  if (!supabaseUrl || !supabaseKey) return json({ error: "SMS service is not configured: add SUPABASE_URL and SUPABASE_ANON_KEY to Netlify function environment variables." }, 503);

  const db = createClient(supabaseUrl, supabaseKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const userResult = await db.auth.getUser(token);
    const user = userResult.data.user;
    if (userResult.error || !user) return json({ error: "Your session has expired. Sign in again." }, 401);

    const body = await req.json() as { invoice_id?: string; consent_confirmed?: boolean; retry_failed?: boolean };
    if (!body.invoice_id) return json({ error: "Choose an invoice first." }, 400);
    if (body.consent_confirmed !== true) return json({ error: "Confirm that the tenant has agreed to receive billing SMS messages." }, 400);

    const invoiceResult = await db.from("invoices").select("*").eq("id", body.invoice_id).maybeSingle();
    const invoice = invoiceResult.data;
    if (invoiceResult.error || !invoice) return json({ error: "Invoice not found or access denied." }, 404);

    const [tenantResult, unitResult, propertyResult, priorResult] = await Promise.all([
      db.from("tenants").select("id,full_name,phone,property_id,sms_opt_in").eq("id", invoice.tenant_id).maybeSingle(),
      db.from("units").select("label").eq("id", invoice.unit_id).maybeSingle(),
      db.from("properties").select("id,name,currency").eq("id", invoice.property_id).maybeSingle(),
      db.from("invoice_sms_logs").select("id,status,created_at").eq("invoice_id", invoice.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    const tenant = tenantResult.data;
    const property = propertyResult.data;
    if (tenantResult.error || !tenant || propertyResult.error || !property) return json({ error: "Tenant or property details could not be loaded." }, 400);
    if (tenant.property_id !== invoice.property_id) return json({ error: "Invoice and tenant do not belong to the same property." }, 400);
    if (priorResult.data?.status === "sent") return json({ error: "This invoice has already been sent by SMS. Duplicate messages are blocked." }, 409);
    if (priorResult.data?.status === "failed" && body.retry_failed !== true) return json({ error: "The previous SMS failed. Use Retry failed message to try again." }, 409);

    const phone = normalizeKenyanPhone(tenant.phone || "");
    const monthLabel = new Date(invoice.billing_month + "T00:00:00").toLocaleDateString("en-KE", { month: "long", year: "numeric" });
    const unit = unitResult.data?.label ? ` / Unit ${unitResult.data.label}` : "";
    const amount = new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(Number(invoice.total || 0));
    const due = invoice.due_date ? new Date(invoice.due_date + "T00:00:00").toLocaleDateString("en-KE") : "as soon as possible";
    const message = `Hi ${tenant.full_name}, your ${monthLabel} invoice for ${property.name}${unit} is KES ${amount}, due ${due}. Please contact management with questions.`;
    let status: "sent" | "failed" = "failed";
    let providerMessageId: string | null = null;
    let errorMessage: string | null = null;

    if (!phone) {
      errorMessage = "Tenant phone number is not a valid Kenyan mobile number.";
    } else if (!username || !apiKey) {
      errorMessage = "Africa's Talking is not configured. Add AT_USERNAME and AT_API_KEY to Netlify function environment variables.";
    } else {
      try {
        const form = new URLSearchParams({ username, to: phone, message });
        if (senderId) form.set("from", senderId);
        const endpoint = username.toLowerCase() === "sandbox"
          ? "https://api.sandbox.africastalking.com/version1/messaging"
          : "https://api.africastalking.com/version1/messaging";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { apiKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });
        const responseText = await response.text();
        let payload: any = {};
        try { payload = JSON.parse(responseText); } catch { /* provider returned non-JSON */ }
        const recipient = payload?.SMSMessageData?.Recipients?.[0];
        if (response.ok && recipient && Number(recipient.statusCode) === 101) {
          status = "sent";
          providerMessageId = recipient.messageId || null;
        } else {
          errorMessage = recipient?.status || payload?.SMSMessageData?.Message || `SMS provider rejected the message (HTTP ${response.status}).`;
        }
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "SMS provider request failed.";
      }
    }

    const log = await db.from("invoice_sms_logs").insert({
      property_id: invoice.property_id,
      invoice_id: invoice.id,
      tenant_id: tenant.id,
      phone: phone || tenant.phone || "",
      message,
      status,
      provider: "africas_talking",
      provider_message_id: providerMessageId,
      error_message: errorMessage,
      created_by: user.id,
    }).select("id,status,created_at,error_message").single();
    if (log.error) return json({ error: "SMS attempt finished, but RentFlow could not save the message history. " + log.error.message, provider_status: status }, 500);
    if (status === "failed") return json({ error: errorMessage || "SMS delivery failed.", log: log.data }, 502);
    return json({ success: true, log: log.data, message: "SMS accepted by the provider." });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unexpected SMS error." }, 500);
  }
};
