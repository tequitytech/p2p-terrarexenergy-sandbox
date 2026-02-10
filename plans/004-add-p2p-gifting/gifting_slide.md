Person who offers energy gift knows gift recipient’s phone number. They ask the seller to publish an offer marked as gift on catalog. It is seeded with a hash of a claim secret and/or gift recipient’s phone. It is claimable by them with a claim secret (to be sent off-channel, via SMS to gifter, and/or giftee ) and/or ownership of phone number, on any buyer platform. 
Creation: Gifter sets amount/phone → Platform generates 8-char secret → Hashes published → SMS sent.
Discovery: Recipient logs into their preferred app → App computes lookupHash → Queries CDS for matches.
Claim: Recipient enters SMS secret → BPP validates claimVerifier → Standard Beckn flow initiates.
Delivery: Energy is scheduled to the recipient's meter → Status updated to CLAIMED.
Schema changes: offerAttributes will have optional new sub-attribute EnergyGift.
lookupHash: SHA256 of recipient phone for discovery.
claimVerifier: SHA256 of claim secret for validation.
expiresAt: Gift expiration timestamp.
Energy, delivery window, price (0) and activestatus is already within Offer object.

