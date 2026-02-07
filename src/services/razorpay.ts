import dotenv from 'dotenv';
import Razorpay from 'razorpay';
dotenv.config();

export const rzp_key_id = process.env.RAZORPAY_KEY_ID || "rzp_test_lFV7rQfvogqH9V";
export const rzp_key_secret = process.env.RAZORPAY_KEY_SECRET || "ba9agxOt89nx0Y6SYc7dtXPy";

if (!rzp_key_id || !rzp_key_secret) {
    console.warn('[Razorpay] RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing. Payment features may not work.');
}

export const razorpay = new Razorpay({
    key_id: rzp_key_id,
    key_secret: rzp_key_secret,
});
