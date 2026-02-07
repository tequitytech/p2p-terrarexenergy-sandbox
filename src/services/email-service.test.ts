import nodemailer from 'nodemailer';

import { emailService } from './email-service';

// Mock nodemailer
jest.mock('nodemailer');
const mockedNodemailer = nodemailer as jest.Mocked<typeof nodemailer>;

describe('EmailService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should use Ethereal when SMTP is not configured', async () => {
    delete process.env.SMTP_HOST;
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    
    const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'test-id' });
    mockedNodemailer.createTestAccount.mockResolvedValue({
      user: 'testuser',
      pass: 'testpass'
    } as any);
    mockedNodemailer.createTransport.mockReturnValue({
      sendMail: sendMailMock
    } as any);
    mockedNodemailer.getTestMessageUrl.mockReturnValue('http://preview.url');

    const result = await emailService.sendEmail('test@example.com', 'Test Subject', 'Test Body');

    expect(result).toBe(true);
    expect(mockedNodemailer.createTestAccount).toHaveBeenCalled();
    expect(mockedNodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.ethereal.email'
    }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('http://preview.url'));
    
    consoleSpy.mockRestore();
  });

  it('should use nodemailer when SMTP is configured', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';

    const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'test-id' });
    mockedNodemailer.createTransport.mockReturnValue({
      sendMail: sendMailMock
    } as any);

    const result = await emailService.sendEmail('test@example.com', 'Subject', 'Body');

    expect(result).toBe(true);
    expect(mockedNodemailer.createTransport).toHaveBeenCalled();
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.com',
      subject: 'Subject',
      html: 'Body'
    }));
  });

  it('should return false on error', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    mockedNodemailer.createTransport.mockReturnValue({
      sendMail: jest.fn().mockRejectedValue(new Error('SMTP Error'))
    } as any);

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await emailService.sendEmail('test@example.com', 'Subject', 'Body');

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });
});
