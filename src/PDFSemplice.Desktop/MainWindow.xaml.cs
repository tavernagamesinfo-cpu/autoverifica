using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;
using System.IO;
using System.Windows;

namespace PDFSemplice.Desktop;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += MainWindow_Loaded;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await Browser.EnsureCoreWebView2Async();
            Browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            Browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            Browser.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = true;

            var assetsPath = Path.Combine(AppContext.BaseDirectory, "Assets");
            if (!Directory.Exists(assetsPath)) throw new DirectoryNotFoundException("Cartella Assets non trovata.");

            Browser.CoreWebView2.SetVirtualHostNameToFolderMapping(
                "app.pdfsemplice.local", assetsPath, CoreWebView2HostResourceAccessKind.DenyCors);

            Browser.CoreWebView2.DownloadStarting += CoreWebView2_DownloadStarting;
            Browser.CoreWebView2.NewWindowRequested += CoreWebView2_NewWindowRequested;
            Browser.Source = new Uri("https://app.pdfsemplice.local/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "PDF Semplice non riesce ad avviare il motore WebView2.\n\n" +
                "Su Windows 11 è già incluso. Su alcuni PC Windows 10 può essere necessario installare Microsoft Edge WebView2 Runtime.\n\n" +
                "Dettaglio: " + ex.Message,
                "PDF Semplice", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    private void CoreWebView2_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
    }

    private void CoreWebView2_DownloadStarting(object? sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var deferral = e.GetDeferral();
        try
        {
            string suggested = Path.GetFileName(e.ResultFilePath);
            if (string.IsNullOrWhiteSpace(suggested)) suggested = "documento";

            var dialog = new SaveFileDialog
            {
                FileName = suggested,
                AddExtension = true,
                OverwritePrompt = true,
                CheckPathExists = true,
                Title = "Salva file"
            };

            var ext = Path.GetExtension(suggested).ToLowerInvariant();
            dialog.Filter = ext switch
            {
                ".pdf" => "PDF (*.pdf)|*.pdf|Tutti i file (*.*)|*.*",
                ".zip" => "Archivio ZIP (*.zip)|*.zip|Tutti i file (*.*)|*.*",
                ".jpg" or ".jpeg" => "Immagine JPEG (*.jpg;*.jpeg)|*.jpg;*.jpeg|Tutti i file (*.*)|*.*",
                ".png" => "Immagine PNG (*.png)|*.png|Tutti i file (*.*)|*.*",
                _ => "Tutti i file (*.*)|*.*"
            };

            if (dialog.ShowDialog(this) == true)
            {
                e.ResultFilePath = dialog.FileName;
                e.Handled = false;
            }
            else e.Cancel = true;
        }
        finally { deferral.Complete(); }
    }
}
