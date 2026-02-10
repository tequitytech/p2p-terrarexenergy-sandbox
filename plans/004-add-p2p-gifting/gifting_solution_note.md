# **Note: Cross-Platform Energy Gifting**

**Beckn Distributed Energy Generation (DEG) Network**

| Attribute | Details |
| :---- | :---- |
| **Version** | 1.0 |
| **Date** | February 2026 |
| **Authors** | TerraRex Energy |
| **Status** | Draft for Review |

## 

## **1\. Summary**

This note introduces a gifting mechanism for the Beckn DEG network, allowing users to transfer energy across participating platforms. The design prioritises **privacy**, **security**, and **minimal protocol changes** while maintaining a decentralised architecture.

The core innovation is a **two-hash cryptographic model** that enables gift discovery without exposing recipient phone numbers and claim verification without a central authority.

## 

## **2\. Problem Statement**

Current P2P energy trading supports direct buyer-seller transactions, but lacks flexibility for social transfers. Currently, users cannot:

* Gift energy to friends/family across different apps (e.g., App A to App B).  
* Transfer energy without revealing recipient PII (Personally Identifiable Information) to the network.  
* Utilise a trustless mechanism for cross-platform verification.

## 

## 

## **3\. Proposed Solution**

### **3.1 Overview**

A prosumer can gift energy by specifying a recipient's phone number. The platform generates cryptographic identifiers and a secret claim code sent via SMS. The recipient can then claim this gift from *any* Beckn-compliant application.

### **3.2 The Two-Hash Model**

Two separate hashes ensure discovery and verification remain private:

1. **Lookup Hash (Discovery):** Published to the CDS to allow the recipient's app to "find" the gift.  
   * lookupHash \= SHA256(recipientPhone ~~\+ NETWORK\_SALT~~)  
2. **Claim Verifier (Validation):** Published to the CDS to allow the BPP to verify the claim.  
   * claimVerifier \= SHA256(claimSecret ~~\+ giftId~~)

### **3.3 Why This Works**

| Concern | How It's Addressed |
| :---- | :---- |
| **Privacy** | Phone numbers are never published; only the irreversible hash is visible. |
| **Security** | Claims require a secret code known only to the SMS recipient. |
| **Decentralization** | No central authority; any BPP can validate the hash independently. |
| **Compatibility** | Any app can compute the same hash using the shared NETWORK\_SALT. |

## 

## 

## 

##  **4\. Technical Specification**

### **4.1 New Catalog Item Attributes**

| Field | Purpose |
| :---- | :---- |
| lookupHash | SHA256 of recipient phone for discovery. |
| claimVerifier | SHA256 of claim secret for validation. |
| energyKwh | Amount of energy being gifted. |
| status | UNCLAIMED, CLAIMED, or EXPIRED. |
| expiresAt | Gift expiration timestamp. |

### **4.2 Gift Lifecycle**

1. **Creation:** Gifter sets amount/phone → Platform generates 8-char secret → Hashes published → SMS sent.  
2. **Discovery:** Recipient logs into their preferred app → App computes lookupHash → Queries CDS for matches.  
3. **Claim:** Recipient enters SMS secret → BPP validates claimVerifier → Standard Beckn flow initiates.  
4. **Delivery:** Energy is scheduled to the recipient's meter → Status updated to CLAIMED.

## 

## **5\. Security Analysis**

**Network-Wide Constant:** NETWORK\_SALT \= "beckn-deg-p2p-gift-v1"

*Purpose: Namespace hashes and add entropy. This is a public constant.*

* **Reversing Hashes:** SHA256 combined with the salt makes phone number reversal computationally infeasible.  
* **Brute Force:** The 8-character alphanumeric secret provides \~2.8 trillion combinations.  
* **App Integrity:** No trust is required in the claiming app; the BPP performs the final validation of the secret.

## 

## **6\. Implementation & Scope**

### **6.1 Comparison with Alternatives**

| Approach | Privacy | Security | Complexity |
| :---- | :---- | :---- | :---- |
| Publish Phone Number | Poor | N/A | Low |
| Central Registry | Moderate | Central Trust | High |
| **Two-Hash Model** | **Strong** | **Trustless** | **Moderate** |

## 

## **7\. Conclusion**

The two-hash model provides a "UPI-like" experience for energy gifting without compromising the privacy of the participants. We recommend a pilot program with 2-3 platforms to validate the flow before a full network rollout.

### **Next Steps**

* Define standard error codes for failed claims.  
* Finalise the NETWORK\_SALT rotation policy.