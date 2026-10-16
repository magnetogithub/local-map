using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A local notification application. No scripts, policy changes, or network access.
internal static class Prompt15Notify
{
    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        try
        {
            if (args.Length != 1) throw new ArgumentException("A JSON notification payload is required.");
            var payload = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0], Encoding.UTF8));
            string title = Convert.ToString(payload["title"]);
            string body = Convert.ToString(payload["body"]);
            Application.EnableVisualStyles();
            bool shown = false;
            using (var icon = new NotifyIcon())
            using (var show = new Timer())
            using (var finish = new Timer())
            {
                icon.Icon = SystemIcons.Information;
                icon.Text = "Prompt 15 task notifications";
                icon.Visible = true;
                icon.BalloonTipShown += delegate { shown = true; };
                icon.BalloonTipClicked += delegate { Application.ExitThread(); };
                icon.BalloonTipClosed += delegate { Application.ExitThread(); };
                show.Interval = 250;
                show.Tick += delegate
                {
                    show.Stop();
                    icon.ShowBalloonTip(10000, title, body, ToolTipIcon.Info);
                };
                finish.Interval = 12000;
                finish.Tick += delegate { Application.ExitThread(); };
                show.Start();
                finish.Start();
                Application.Run();
                icon.Visible = false;
            }
            Console.WriteLine(json.Serialize(new { sent = shown, displayed = shown, sender = "Prompt 15", error = shown ? null : "Windows did not report the notification as displayed." }));
            return shown ? 0 : 1;
        }
        catch (Exception error)
        {
            Console.WriteLine(json.Serialize(new { sent = false, error = error.Message }));
            return 1;
        }
    }
}
