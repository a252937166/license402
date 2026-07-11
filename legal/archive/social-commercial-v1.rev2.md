LICENSE402 STANDARD SOCIAL COMMERCIAL LICENSE
Template ID: social-commercial-v1
Version: 1 (Pilot Terms)

1. PARTIES.
   "Licensor" is the wallet address that signed the CreatorOffer for the Asset.
   "Licensee" is the wallet address that expressly authorized the purchase and
   settled payment — either by signing an EIP-712 PurchaseIntent, or by signing
   the x402 payment authorization itself in a direct purchase (the credential's
   authorizationMode records which). "LICENSE402" (the "Service") is the issuer
   that mints the License Credential after verifying consent and settlement.

2. ASSET. This license applies to the single image identified by the SHA-256
   hash recorded in the License Credential ("assetSha256"). It applies to no
   other file.

3. GRANT. Subject to payment and to the machine-readable scope policy embedded
   in the License Credential, the Licensor grants the Licensee a non-exclusive,
   non-transferable, worldwide license to use the Asset for commercial posts on
   the social channels named in the grant, for the granted duration, including
   the granted transformations (which may include crop, resize, and text
   overlay).

4. PROHIBITIONS. This license does NOT permit, and the Licensee shall not:
   (a) use the Asset to train, fine-tune, or evaluate any machine-learning model;
   (b) index the Asset into a retrieval-augmented-generation corpus;
   (c) resell, relicense, or sublicense the Asset or this license;
   (d) claim exclusive rights in the Asset;
   (e) use the Asset outside the granted channels, territory, or duration.

5. ATTRIBUTION. Where the scope policy records an attribution duty, the Licensee
   shall display the attribution text supplied by the scope check when the Asset
   is published.

6. RIGHTS DECLARATION. The Licensor declares, by signing the CreatorOffer, that
   it holds the rights necessary to grant this license. The Service verifies
   signatures, asset hashes, and settlement; it does not adjudicate copyright
   ownership and makes no representation that the Licensor's declaration is
   accurate. This document is a machine-checkable licensing record, not a legal
   determination of ownership or of infringement.

7. MACHINE POLICY PRECEDENCE. The License Credential carries an executable scope
   policy that is a projection of this text. Automated scope checks use that
   policy. Where the machine policy and this versioned legal text conflict, THIS
   LEGAL TEXT PREVAILS.

8. TAKEDOWN & DISPUTE. Payment failure to the Licensor does not by itself revoke
   a validly issued license. Fraud, misissuance, a rights dispute, or a lawful
   takedown request may trigger suspension or revocation through the Service's
   documented process. Current credential status is available at the statusUrl
   in the credential.

9. NON-DRM. The Service does not apply digital-rights-management enforcement.
   After download the Service cannot physically prevent copying. What it provides
   is an auditable license, payment records, and a scope check.

10. LIABILITY. The Asset and this license are provided "as is" to the maximum
    extent permitted by law. The Service's aggregate liability for any claim
    arising from a transaction is limited to the amount the Licensee paid for
    that transaction.

11. NON-TRANSFERABILITY. This license is bound to the Licensee wallet recorded
    in the credential and may not be transferred.

12. PAYMENT & REFUND. The license activates only upon successful settlement of
    the Licensee's payment. Pilot Terms pricing is fixed per the offer and is
    not refundable once the license is active, except where required by law.
