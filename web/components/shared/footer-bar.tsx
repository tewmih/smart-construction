export function FooterBar() {
  return (
    <footer className="border-t border-border bg-background text-center text-sm text-muted-foreground py-4">
      <p>&copy; {new Date().getFullYear()} Foresite. All rights reserved.</p>
    </footer>
  )
}
