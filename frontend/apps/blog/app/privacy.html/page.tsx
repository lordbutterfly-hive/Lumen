/**
 * ★★ POLICY TEXT REMOVED 2026-08-27, ON THE OWNER'S INSTRUCTION.
 *
 * Owner: "get rid of the privacy policy. says we collect phone numbers and IP
 * addresses. thats not true. we dont collect anything. get rid of privacy policy
 * or keep the page but delete all the text. we can deal with that later."
 *
 * The removed document described collection Lumen does not do. Two claims were
 * verified false against the product before deleting:
 *   - "IP address;"                                   (old page.tsx:72)
 *   - "your email address and telephone number;"      (old page.tsx:84)
 * Publishing a policy that overstates collection is worse than publishing none:
 * it is a representation to users and to regulators about behaviour that does not
 * happen, and it cannot be defended by pointing at the code.
 *
 * The ROUTE is deliberately kept rather than deleted. `/privacy` 308s here
 * (next.config.js redirects), the footer and the sign-up consent line both link
 * here, and legal pages get linked and indexed from outside where a 404 is not
 * recoverable by the reader. So the page stays and says, honestly, that the text
 * is being rewritten.
 *
 * The full original is preserved at
 * `~/lumen-logs/privacy-policy-ORIGINAL-2026-08-27.tsx` for whoever writes the
 * replacement — do not restore it wholesale, it is the document that was wrong.
 */
const PrivacyPage = () => {
  return (
    <div className="my-12 flex flex-col items-center p-2">
      <div className="mb-4 max-w-2xl text-body-sm">
        <h1 className="mb-4 text-4xl sm:text-6xl">Privacy Policy</h1>
        <p className="mb-4">
          <span>
            This policy is being rewritten. The previous version described data collection that Lumen does
            not carry out, so it has been taken down rather than left up while it is corrected.
          </span>
        </p>
      </div>
    </div>
  );
};

export default PrivacyPage;
