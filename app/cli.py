"""
CLI tool for TAS - statistics and monitoring.
Usage: tas stats [options]
"""
import click
import sys
from pathlib import Path
from typing import Dict, Any

# Add app to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.metrics import metrics_collector
from app.config import settings


@click.group()
def cli():
    """TAS CLI - Statistics and monitoring."""
    pass


@cli.command()
@click.option('--format', type=click.Choice(['table', 'json', 'prometheus']), default='table', help='Output format')
@click.option('--alerts', is_flag=True, help='Show alerts only')
def stats(format: str, alerts: bool):
    """Display current metrics and statistics."""
    metrics = metrics_collector.get_current_metrics()
    alert_list = metrics_collector.check_alerts()
    
    if alerts:
        # Show only alerts
        if not alert_list:
            click.echo("✅ No alerts - all metrics are within thresholds")
            return
        
        click.echo("⚠️  Active Alerts:")
        click.echo()
        for alert in alert_list:
            severity_icon = "🔴" if alert["severity"] == "critical" else "🟡"
            click.echo(f"{severity_icon} {alert['severity'].upper()}: {alert['message']}")
        return
    
    if format == 'json':
        import json
        output = {
            "metrics": metrics,
            "alerts": alert_list
        }
        click.echo(json.dumps(output, indent=2))
    elif format == 'prometheus':
        from prometheus_client import generate_latest
        click.echo(generate_latest().decode('utf-8'))
    else:
        # Table format
        _print_table(metrics, alert_list)


def _print_table(metrics: Dict[str, Any], alerts: list):
    """Print metrics in a formatted table."""
    click.echo("📊 TAS Statistics")
    click.echo("=" * 70)
    click.echo()
    
    # Performance Metrics
    click.echo("⚡ Performance Metrics:")
    click.echo(f"  Total Requests:      {metrics['total_requests']:,}")
    click.echo(f"  Spam Detected:       {metrics['spam_detected']:,}")
    click.echo(f"  Ham Detected:        {metrics['ham_detected']:,}")
    click.echo(f"  P95 Latency:         {metrics['latency_p95_ms']:.2f} ms")
    click.echo()
    
    # Quality Metrics
    click.echo("🎯 Quality Metrics:")
    fpr = metrics['fpr']
    recall = metrics['recall']
    fpr_status = "✅" if fpr < 0.05 else "⚠️" if fpr < 0.10 else "🔴"
    recall_status = "✅" if recall >= 0.70 else "⚠️" if recall >= 0.50 else "🔴"
    
    click.echo(f"  False Positive Rate: {fpr:.2%} {fpr_status} (target: <5%)")
    click.echo(f"  Recall:              {recall:.2%} {recall_status} (target: >70%)")
    click.echo()
    
    # LLM Metrics
    click.echo("🤖 LLM Metrics:")
    click.echo(f"  LLM Requests:        {metrics['llm_requests']:,}")
    click.echo(f"  Cache Hits:          {metrics['llm_cache_hits']:,}")
    hit_rate = metrics['llm_hit_rate']
    hit_rate_status = "✅" if hit_rate >= 0.15 else "⚠️"
    click.echo(f"  Cache Hit Rate:      {hit_rate:.2%} {hit_rate_status} (target: >15%)")
    click.echo()
    
    # Cost Metrics
    click.echo("💰 Cost Metrics:")
    daily_cost = metrics['llm_daily_cost_usd']
    monthly_cost = metrics['llm_monthly_cost_usd']
    total_cost = metrics['llm_cost_usd']
    daily_budget = metrics['daily_budget_usd']
    monthly_budget = metrics['monthly_budget_usd']
    
    budget_status = "✅" if daily_cost <= daily_budget * 0.8 else "⚠️" if daily_cost <= daily_budget else "🔴"
    click.echo(f"  Daily Cost:          ${daily_cost:.2f} / ${daily_budget:.2f} {budget_status}")
    click.echo(f"  Monthly Cost:        ${monthly_cost:.2f} / ${monthly_budget:.2f}")
    click.echo(f"  Total Cost:          ${total_cost:.2f}")
    
    if metrics['budget_warning']:
        click.echo(f"  ⚠️  Warning: Daily cost is above 80% of budget")
    if metrics['budget_exceeded']:
        click.echo(f"  🔴 Critical: Daily cost exceeds budget!")
    click.echo()
    
    # Alerts
    if alerts:
        click.echo("⚠️  Active Alerts:")
        for alert in alerts:
            severity_icon = "🔴" if alert["severity"] == "critical" else "🟡"
            click.echo(f"  {severity_icon} {alert['severity'].upper()}: {alert['message']}")
        click.echo()
    else:
        click.echo("✅ No active alerts")
        click.echo()
    
    click.echo("=" * 70)


@cli.command()
@click.option('--daily', type=float, help='Set daily budget in USD')
@click.option('--monthly', type=float, help='Set monthly budget in USD')
def budget(daily: float, monthly: float):
    """Set cost budgets."""
    if daily is None and monthly is None:
        current = metrics_collector.get_current_metrics()
        click.echo(f"Current budgets:")
        click.echo(f"  Daily:   ${current['daily_budget_usd']:.2f}")
        click.echo(f"  Monthly: ${current['monthly_budget_usd']:.2f}")
        return
    
    metrics_collector.set_budget(daily=daily, monthly=monthly)
    
    if daily is not None:
        click.echo(f"✅ Daily budget set to ${daily:.2f}")
    if monthly is not None:
        click.echo(f"✅ Monthly budget set to ${monthly:.2f}")


@cli.command()
def alerts():
    """Show current alerts."""
    alert_list = metrics_collector.check_alerts()
    
    if not alert_list:
        click.echo("✅ No active alerts - all metrics are within thresholds")
        return
    
    click.echo(f"⚠️  Found {len(alert_list)} active alert(s):")
    click.echo()
    
    for i, alert in enumerate(alert_list, 1):
        severity_icon = "🔴" if alert["severity"] == "critical" else "🟡"
        click.echo(f"{i}. {severity_icon} {alert['severity'].upper()}: {alert['message']}")
        click.echo(f"   Metric: {alert['metric']}")
        click.echo(f"   Value: {alert['value']}")
        click.echo(f"   Threshold: {alert['threshold']}")
        click.echo()


if __name__ == '__main__':
    cli()

