import asyncio
import csv
from pathlib import Path
from app.pipeline import pipeline
from app.config import settings
from typing import Dict, List, Tuple


async def test_thresholds():
    csv_path = Path(__file__).parent.parent.parent / "report.csv"
    
    if not csv_path.exists():
        print(f"report.csv not found at {csv_path}")
        return
    
    test_cases = [
        {"rules": 0.6, "ml": 0.7},
        {"rules": 0.7, "ml": 0.8},
        {"rules": 0.7, "ml": 0.75},
        {"rules": 0.65, "ml": 0.8},
        {"rules": 0.75, "ml": 0.85},
        {"rules": 0.8, "ml": 0.85},
    ]
    
    results = []
    
    data = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for i, row in enumerate(reader):
            if i >= 500:
                break
            
            message = row.get('Message Content', '').strip()
            if not message:
                continue
            
            is_spam = row.get('Is Spam', '').strip()
            if is_spam not in ['0', '1']:
                continue
            
            data.append({
                'text': message,
                'expected': int(is_spam) == 1
            })
    
    print(f"Loaded {len(data)} test cases\n")
    
    for test_case in test_cases:
        rules_threshold = test_case["rules"]
        ml_threshold = test_case["ml"]
        
        settings.rules_threshold = rules_threshold
        settings.ml_threshold = ml_threshold
        
        print(f"Testing: rules_threshold={rules_threshold}, ml_threshold={ml_threshold}")
        
        total = 0
        correct = 0
        true_positives = 0
        false_positives = 0
        true_negatives = 0
        false_negatives = 0
        
        rules_only = 0
        ml_used = 0
        llm_used = 0
        
        for item in data:
            result = await pipeline.classify(item['text'])
            predicted = result['spam_score'] >= 0.5
            expected = item['expected']
            
            total += 1
            
            if predicted == expected:
                correct += 1
                if predicted:
                    true_positives += 1
                else:
                    true_negatives += 1
            else:
                if predicted:
                    false_positives += 1
                else:
                    false_negatives += 1
            
            layers = result.get('layers_used', [])
            if 'llm' in layers:
                llm_used += 1
            elif 'ml' in layers:
                ml_used += 1
            else:
                rules_only += 1
        
        accuracy = (correct / total) * 100 if total > 0 else 0
        precision = (true_positives / (true_positives + false_positives)) * 100 if (true_positives + false_positives) > 0 else 0
        recall = (true_positives / (true_positives + false_negatives)) * 100 if (true_positives + false_negatives) > 0 else 0
        f1 = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
        
        results.append({
            'rules_threshold': rules_threshold,
            'ml_threshold': ml_threshold,
            'accuracy': accuracy,
            'precision': precision,
            'recall': recall,
            'f1': f1,
            'rules_only_pct': (rules_only / total) * 100,
            'ml_used_pct': (ml_used / total) * 100,
            'llm_used_pct': (llm_used / total) * 100,
        })
        
        print(f"  Accuracy: {accuracy:.2f}% | Precision: {precision:.2f}% | Recall: {recall:.2f}% | F1: {f1:.2f}%")
        print(f"  Layers: Rules only {rules_only/total*100:.1f}% | ML {ml_used/total*100:.1f}% | LLM {llm_used/total*100:.1f}%\n")
    
    print("="*70)
    print("OPTIMAL SETTINGS ANALYSIS")
    print("="*70)
    
    best_f1 = max(results, key=lambda x: x['f1'])
    best_accuracy = max(results, key=lambda x: x['accuracy'])
    best_balanced = max(results, key=lambda x: x['f1'] + x['accuracy'] - abs(x['recall'] - x['precision']))
    
    print(f"\nBest F1 Score:")
    print(f"  Rules: {best_f1['rules_threshold']}, ML: {best_f1['ml_threshold']}")
    print(f"  F1: {best_f1['f1']:.2f}% | Accuracy: {best_f1['accuracy']:.2f}% | Precision: {best_f1['precision']:.2f}% | Recall: {best_f1['recall']:.2f}%")
    
    print(f"\nBest Accuracy:")
    print(f"  Rules: {best_accuracy['rules_threshold']}, ML: {best_accuracy['ml_threshold']}")
    print(f"  F1: {best_accuracy['f1']:.2f}% | Accuracy: {best_accuracy['accuracy']:.2f}% | Precision: {best_accuracy['precision']:.2f}% | Recall: {best_accuracy['recall']:.2f}%")
    
    print(f"\nBest Balanced (Recommended):")
    print(f"  Rules: {best_balanced['rules_threshold']}, ML: {best_balanced['ml_threshold']}")
    print(f"  F1: {best_balanced['f1']:.2f}% | Accuracy: {best_balanced['accuracy']:.2f}% | Precision: {best_balanced['precision']:.2f}% | Recall: {best_balanced['recall']:.2f}%")
    print(f"  Layers: Rules {best_balanced['rules_only_pct']:.1f}% | ML {best_balanced['ml_used_pct']:.1f}% | LLM {best_balanced['llm_used_pct']:.1f}%")
    
    return best_balanced


if __name__ == "__main__":
    result = asyncio.run(test_thresholds())
    print(f"\nRecommended settings:")
    print(f"RULES_THRESHOLD={result['rules_threshold']}")
    print(f"ML_THRESHOLD={result['ml_threshold']}")

