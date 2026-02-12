import admin from "../filebaseClient";

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
        console.log('NOTIFICATION_SENT', {
            message: 'Notification send',
            response
        })
    } catch (error) {
        console.log('NOTIFICATION_SENT_ERROR', {
            message: 'Notification send error',
            error
        })
    }
}