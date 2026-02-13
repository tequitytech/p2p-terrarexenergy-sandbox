import admin from "../firebaseClient";

export async function sendNotification(token: string, title: string, body: string) {
    const message = {
        notification: {
            title,
            body,
        },
        token,
        android: {
            priority: "high" as const,
            notification: {
                channelId: "default",
                priority: "high" as const,
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);
        console.log('PUSH_NOTIFICATION_SENT', {
            message: 'Push notification send',
            response
        })
    } catch (error) {
        console.error('PUSH_NOTIFICATION_SENT_ERROR', {
            message: 'Push notification send error',
            error
        })
    }
}
